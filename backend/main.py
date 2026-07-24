from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from ultralytics import YOLO
import os
import base64

app = FastAPI(
    title="API 1104 Weld Inspection System",
    version="1.5.0"
)

# Configuración de CORS para permitir peticiones desde Vercel
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Autenticación Corporativa
COMPANY_API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!"
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Depends(api_key_header)):
    if api_key != COMPANY_API_KEY:
        raise HTTPException(
            status_code=403, 
            detail="Acceso denegado: Credencial privada corporativa no válida."
        )
    return api_key

import torch
from ultralytics.nn.tasks import DetectionModel

# Permitir la clase DetectionModel en PyTorch para evitar el error de Unpickling en Render
torch.serialization.add_safe_globals([DetectionModel])

# Cargar Modelo YOLO Real (.pt)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "best.pt")

if os.path.exists(MODEL_PATH):
    print(f"Loading YOLO model from: {MODEL_PATH}")
    try:
        model = YOLO(MODEL_PATH)
    except Exception as e:
        print(f"Error loading YOLO model: {e}")
        model = None
else:
    print(f"Warning: {MODEL_PATH} not found. Running in fallback mode.")
    model = None

# Tabla de Diámetros Exteriores Reales (OD) en mm
OD_TABLE_MM = {
    "4": 114.3,
    "6": 168.3,
    "8": 219.1,
    "10": 273.1,
    "12": 323.9
}

def compute_scale_mm_per_px(image: np.ndarray, od_real_mm: float):
    """Calcula la escala mm/px basada en la altura de la toma."""
    h, w, _ = image.shape
    detected_pipe_diameter_px = h * 0.70  # Apertura de las guías
    
    scale_mm_px = od_real_mm / detected_pipe_diameter_px
    px_per_mm = 1.0 / scale_mm_px
    
    if px_per_mm < 3.0:
        return None, "Calidad insuficiente: Acerque más la cámara para enfocar el cordón."
        
    return scale_mm_px, None

def evaluate_api1104_rules(defect_type: str, size_mm: float):
    """Aplica las reglas de aceptación/rechazo según la norma API 1104 Sec. 9.3."""
    verdict = "APROBADO"
    clause = "API 1104 Sec. 9.3"
    observation = "Discontinuidad dentro de los límites permisibles."
    defect_lower = defect_type.lower()

    if "poros" in defect_lower or "porosity" in defect_lower:
        if size_mm > 1.6:
            verdict = "RECHAZADO"
            clause = "API 1104 Sec. 9.3.9"
            observation = f"Porosidad ({size_mm:.2f} mm) excede el límite máximo de 1.6 mm."
    elif "crack" in defect_lower or "grieta" in defect_lower or "fisura" in defect_lower:
        verdict = "RECHAZADO"
        clause = "API 1104 Sec. 9.3.1"
        observation = "Fisura/Grieta detectada. Cero tolerancia bajo norma API 1104."
    elif "lack" in defect_lower or "penetracion" in defect_lower or "non-fusion" in defect_lower:
        verdict = "RECHAZADO"
        clause = "API 1104 Sec. 9.3.2"
        observation = "Falta de fusión/penetración excede los criterios permisibles."
    elif "geometric" in defect_lower or "socavado" in defect_lower:
        if size_mm > 0.8:
            verdict = "RECHAZADO"
            clause = "API 1104 Sec. 9.3.11"
            observation = f"Defecto geométrico/Socavado ({size_mm:.2f} mm) excede tolerancia permisible."

    return verdict, clause, observation

@app.post("/v1/inspect", dependencies=[Depends(verify_api_key)])
@app.post("/v1/inspect/", dependencies=[Depends(verify_api_key)])
async def inspect_weld(
    pipe_diameter_inch: str = Form(...),
    file: UploadFile = File(...)
):
    if pipe_diameter_inch not in OD_TABLE_MM:
        raise HTTPException(status_code=400, detail="Diámetro de tubería no soportado.")

    od_real_mm = OD_TABLE_MM[pipe_diameter_inch]
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Formato de imagen no válido.")

    scale_mm_px, quality_error = compute_scale_mm_per_px(image, od_real_mm)
    if quality_error:
        return {"status": "QUALITY_ERROR", "message": quality_error}

    defect_detected = "Sin Defecto"
    max_size_px = 0.0
    detected_boxes = []

    if model is not None:
        results = model.predict(source=image, conf=0.20)
        boxes = results[0].boxes

        if len(boxes) > 0:
            for box in boxes:
                cls_id = int(box.cls[0])
                class_name = model.names[cls_id]
                conf = float(box.conf[0])
                
                x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
                width_px = x2 - x1
                height_px = y2 - y1
                size_px = max(width_px, height_px)

                detected_boxes.append({
                    "class": class_name,
                    "confidence": conf,
                    "bbox": [x1, y1, x2, y2],
                    "size_px": size_px
                })

                if size_px > max_size_px:
                    max_size_px = size_px
                    defect_detected = class_name

    defect_size_mm = max_size_px * scale_mm_px if max_size_px > 0 else 0.0

    if defect_detected == "Sin Defecto":
        verdict = "APROBADO"
        clause = "API 1104 Sec. 9.3"
        observation = "Cordón libre de discontinuidades detectables."
    else:
        verdict, clause, observation = evaluate_api1104_rules(defect_detected, defect_size_mm)

    # 🎨 DIBUJO DE ALTO CONTRASTE SOBRE LA FALLA
    processed_image = image.copy()
    main_color = (0, 0, 255) if verdict == "RECHAZADO" else (0, 255, 136) # BGR: Rojo o Verde Neón
    border_thickness = 4

    for b in detected_boxes:
        x1, y1, x2, y2 = b["bbox"]
        label = f"{b['class'].upper()} ({b['confidence']*100:.0f}%)"

        # 1. Contorno externo negro de contraste
        cv2.rectangle(processed_image, (x1 - 2, y1 - 2), (x2 + 2, y2 + 2), (0, 0, 0), border_thickness + 2)
        
        # 2. Recuadro principal
        cv2.rectangle(processed_image, (x1, y1), (x2, y2), main_color, border_thickness)

        # 3. Marcas de esquina blancas
        corner_len = int(min(x2 - x1, y2 - y1) * 0.25)
        if corner_len > 5:
            cv2.line(processed_image, (x1, y1), (x1 + corner_len, y1), (255, 255, 255), border_thickness + 1)
            cv2.line(processed_image, (x1, y1), (x1, y1 + corner_len), (255, 255, 255), border_thickness + 1)
            cv2.line(processed_image, (x2, y2), (x2 - corner_len, y2), (255, 255, 255), border_thickness + 1)
            cv2.line(processed_image, (x2, y2), (x2, y2 - corner_len), (255, 255, 255), border_thickness + 1)

        # 4. Etiqueta con fondo
        (w_text, h_text), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
        label_y1 = max(y1 - 30, 0)
        cv2.rectangle(processed_image, (x1, label_y1), (x1 + w_text + 10, label_y1 + 25), main_color, -1)
        cv2.putText(processed_image, label, (x1 + 5, label_y1 + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    # Convertir imagen procesada a Base64
    _, buffer = cv2.imencode('.jpg', processed_image)
    image_base64 = base64.b64encode(buffer).decode('utf-8')

    return {
        "status": "SUCCESS",
        "inspection_summary": {
            "pipe_nominal_size": f"{pipe_diameter_inch}\"",
            "pipe_od_mm": od_real_mm,
            "resolution_scale_mm_px": round(scale_mm_px, 4),
            "defect_detected": defect_detected.capitalize(),
            "defect_size_mm": round(defect_size_mm, 2),
            "verdict": verdict,
            "applied_norm_clause": clause,
            "observation": observation,
            "annotated_image": f"data:image/jpeg;base64,{image_base64}"
        }
    }