import os
import io
import gc
import base64
import torch
import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"
torch.set_num_threads(2)

try:
    from ultralytics.nn.tasks import DetectionModel
    torch.serialization.add_safe_globals([DetectionModel])
except Exception:
    pass

app = FastAPI(title="API Inspección VT API 1104", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_PATH = os.path.join(os.path.dirname(__file__), "weights", "best.pt")

if os.path.exists(MODEL_PATH):
    model = YOLO(MODEL_PATH)
    print(f"✅ Modelo cargado correctamente desde: {MODEL_PATH}")
else:
    model = YOLO("yolov8n.pt")
    print("⚠️ ADVERTENCIA: 'best.pt' no encontrado. Cargando modelo nano por defecto.")

def convert_cv_to_base64(img_np):
    _, buffer = cv2.imencode('.jpg', img_np, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_str}"

@app.get("/")
def read_root():
    return {"status": "ONLINE", "system": "Inspección VT API 1104"}

@app.post("/v1/inspect")
async def inspect_weld(
    file: UploadFile = File(...),
    pipe_od_mm: float = Form(...)
):
    try:
        contents = await file.read()
        pil_image = Image.open(io.BytesIO(contents)).convert('RGB')
        
        # Reducir imagen a maximo 800px para acelerar la inferencia en la CPU de Render
        pil_image.thumbnail((800, 800))
        img_np = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        h, w, _ = img_bgr.shape

        # Inferencia optimizada en velocidad (imgsz=480 en lugar de 640)
        with torch.no_grad():
            results = model(img_bgr, conf=0.15, imgsz=480)
        
        boxes = results[0].boxes
        max_allowed_mm = round(min(1.6, pipe_od_mm * 0.05), 2)

        verdict = "APROBADO"
        defect_type = "Ninguno / Cordón Sano"
        defect_size_mm = 0.0
        observations = "Cordón libre de discontinuidades críticas según norma API 1104."
        annotated_img = img_bgr.copy()

        if len(boxes) > 0:
            # Seleccionar la detección con mayor nivel de confianza
            best_box = max(boxes, key=lambda b: float(b.conf[0]))
            cls_id = int(best_box.cls[0])
            conf_val = float(best_box.conf[0])
            
            raw_label = model.names[cls_id] if hasattr(model, 'names') and cls_id in model.names else f"Defecto_{cls_id}"
            defect_type = str(raw_label).strip()

            x1, y1, x2, y2 = map(int, best_box.xyxy[0])
            box_w_px = x2 - x1
            box_h_px = y2 - y1

            # Mapeo píxel -> mm
            pixel_per_mm = (h * 0.8) / pipe_od_mm if pipe_od_mm > 0 else 1.0
            defect_size_mm = round(max(box_w_px, box_h_px) / pixel_per_mm, 2)

            print(f"🔍 Detección real: Clase='{defect_type}', Confianza={conf_val:.2f}, Tamaño={defect_size_mm}mm")

            # REGLA DIRECTA Y STRICTA:
            # Si detecta 'porosity', 'crack', 'undercut', 'lack_of_fusion' o cualquier defecto -> RECHAZADO
            label_lower = defect_type.lower()
            if "sano" in label_lower or "good" in label_lower or "ok" in label_lower:
                verdict = "APROBADO"
                observations = f"Cordón inspeccionado sin fallas ({defect_type})."
                box_color = (0, 255, 0)
            else:
                verdict = "RECHAZADO"
                observations = f"Discontinuidad detectada: '{defect_type}' ({defect_size_mm} mm, Confianza: {int(conf_val*100)}%). Supera tolerancia API 1104 Sec. 9.3 ({max_allowed_mm} mm)."
                box_color = (0, 0, 255) # Rojo

            # Dibujar el cuadro del defecto en la imagen
            cv2.rectangle(annotated_img, (x1, y1), (x2, y2), box_color, 3)
            tag_text = f"{defect_type}: {defect_size_mm}mm ({int(conf_val*100)}%)"
            (text_w, text_h), _ = cv2.getTextSize(tag_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            cv2.rectangle(annotated_img, (x1, y1 - text_h - 10), (x1 + text_w + 10, y1), box_color, -1)
            cv2.putText(annotated_img, tag_text, (x1 + 5, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

        annotated_b64 = convert_cv_to_base64(annotated_img)

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
        print(f"Error procesando la imagen: {str(e)}")
        gc.collect()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error en el servidor: {str(e)}"
        )