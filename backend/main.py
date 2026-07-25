import os
import io
import gc
import base64
import torch
import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# Limitar hilos de CPU de PyTorch para no saturar la RAM de Render
torch.set_num_threads(1)

# Clave privada corporativa
API_KEY_SECRET = "WeldSec2026_EmpresaPrivada_SecretKey!"

# Parche PyTorch 2.6+
try:
    from ultralytics.nn.tasks import DetectionModel
    torch.serialization.add_safe_globals([DetectionModel])
except Exception:
    pass

app = FastAPI(title="API Inspección VT", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cargar el modelo
MODEL_PATH = os.path.join(os.path.dirname(__file__), "weights", "best.pt")

if os.path.exists(MODEL_PATH):
    model = YOLO(MODEL_PATH)
else:
    model = YOLO("yolov8n.pt")

def verify_api_key(x_api_key: str = Header(None), authorization: str = Header(None)):
    token = x_api_key
    if not token and authorization:
        token = authorization.replace("Bearer ", "").strip()

    if token and token != API_KEY_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Acceso denegado: Credencial no válida."
        )
    return True

def convert_cv_to_base64(img_np):
    # Compresión liviana para ahorrar ancho de banda y memoria
    _, buffer = cv2.imencode('.jpg', img_np, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_str}"

@app.get("/")
def read_root():
    return {"status": "ONLINE"}

@app.post("/v1/inspect")
async def inspect_weld(
    file: UploadFile = File(...),
    pipe_od_mm: float = Form(...),
    x_api_key: str = Header(None),
    authorization: str = Header(None)
):
    verify_api_key(x_api_key, authorization)

    try:
        contents = await file.read()
        pil_image = Image.open(io.BytesIO(contents)).convert('RGB')
        
        # Reducir resolución si la foto es excesivamente grande para no sobrecargar RAM
        pil_image.thumbnail((1280, 1280))
        img_np = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)

        h, w, _ = img_bgr.shape

        # Inferencia optimizada sin gradientes y con dimensión fija de 640px
        with torch.no_grad():
            results = model(img_bgr, conf=0.25, imgsz=640)
        
        boxes = results[0].boxes
        max_allowed_mm = round(min(1.6, pipe_od_mm * 0.05), 2)

        verdict = "APROBADO"
        defect_type = "Ninguno / Cordón Sano"
        defect_size_mm = 0.0
        observations = "Cordón libre de discontinuidades críticas dentro de la norma."
        annotated_b64 = None

        annotated_img = img_bgr.copy()

        if len(boxes) > 0:
            best_box = max(boxes, key=lambda b: float(b.conf[0]))
            cls_id = int(best_box.cls[0])
            label_name = model.names[cls_id] if hasattr(model, 'names') else "Discontinuidad"
            
            x1, y1, x2, y2 = map(int, best_box.xyxy[0])
            box_w_px = x2 - x1
            box_h_px = y2 - y1

            pixel_per_mm = (h * 0.8) / pipe_od_mm if pipe_od_mm > 0 else 1.0
            defect_size_mm = round(max(box_w_px, box_h_px) / pixel_per_mm, 2)
            defect_type = label_name.capitalize()

            if defect_size_mm > max_allowed_mm:
                verdict = "RECHAZADO"
                observations = f"Discontinuidad '{defect_type}' supera tolerancia API 1104 ({max_allowed_mm} mm)."
                box_color = (0, 0, 255)
            else:
                verdict = "APROBADO"
                observations = f"Discontinuidad leve '{defect_type}' dentro de tolerancia."
                box_color = (0, 255, 255)

            cv2.rectangle(annotated_img, (x1, y1), (x2, y2), box_color, 3)
            tag_text = f"{defect_type}: {defect_size_mm}mm"
            (text_w, text_h), _ = cv2.getTextSize(tag_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            cv2.rectangle(annotated_img, (x1, y1 - text_h - 10), (x1 + text_w + 10, y1), box_color, -1)
            cv2.putText(annotated_img, tag_text, (x1 + 5, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

            annotated_b64 = convert_cv_to_base64(annotated_img)
        else:
            annotated_b64 = convert_cv_to_base64(img_bgr)

        # Liberar memoria explícitamente
        del contents, pil_image, img_np, img_bgr, results
        gc.collect()

        return {
            "verdict": verdict,
            "defect_type": defect_type,
            "defect_size_mm": defect_size_mm,
            "max_allowed_mm": max_allowed_mm,
            "norm_clause": "API 1104 Sec. 9.3",
            "observations": observations,
            "annotated_image": annotated_b64
        }

    except Exception as e:
        print(f"Error procesando imagen: {str(e)}")
        gc.collect()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error en el servidor: {str(e)}"
        )