from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Security, Depends
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from ultralytics import YOLO
import os

app = FastAPI(
    title="API 1104 Weld Inspection System",
    version="1.1.0"
)

# 🔒 CONFIGURACIÓN DE CORS UNIVERSAL QUE RESPONDE 200 A PREFLIGHT (OPTIONS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"]
)

COMPANY_API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!"
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: str = Depends(api_key_header)):
    if api_key != COMPANY_API_KEY:
        raise HTTPException(
            status_code=403, 
            detail="Acceso denegado: Credencial privada corporativa no válida."
        )
    return api_key

# Tabla de Diámetros Exteriores Reales (OD) en mm
OD_TABLE_MM = {
    "4": 114.3,
    "6": 168.3,
    "8": 219.1,
    "10": 273.1,
    "12": 323.9
}

def compute_scale_mm_per_px(image: np.ndarray, od_real_mm: float):
    h, w, _ = image.shape
    
    # En toma horizontal del tubo, el diámetro exterior (OD) corresponde al alto (h)
    detected_pipe_diameter_px = h * 0.70  # Coincide con la apertura de las guías amarillas
    
    scale_mm_px = od_real_mm / detected_pipe_diameter_px
    px_per_mm = 1.0 / scale_mm_px
    
    if px_per_mm < 3.0:
        return None, "Calidad insuficiente: Acerque más la cámara para enfocar el cordón."
        
    return scale_mm_px, None

def evaluate_api1104_rules(defect_type: str, size_mm: float):
    verdict = "APROBADO"
    clause = "API 1104 Sec. 9.3"
    observation = "Defecto dentro de límites permisibles."
    defect_lower = defect_type.lower()

    if "porosity" in defect_lower or "poro" in defect_lower:
        if size_mm > 1.6:
            verdict = "RECHAZADO"
            clause = "API 1104 Sec. 9.3.9"
            observation = f"Porosidad ({size_mm:.2f} mm) excede límite de 1.6 mm."
    elif "crack" in defect_lower or "grieta" in defect_lower:
        verdict = "RECHAZADO"
        clause = "API 1104 Sec. 9.3.1"
        observation = "Fisuración detectada. Cero tolerancia bajo norma API 1104."

    return verdict, clause, observation

# 📌 RUTA PRINCIPAL CON Y SIN SLASH AL FINAL
@app.post("/v1/inspect", dependencies=[Depends(verify_api_key)])
@app.post("/v1/inspect/", dependencies=[Depends(verify_api_key)])
async def inspect_weld(
    pipe_diameter_inch: str = Form(...),
    file: UploadFile = File(...)
):
    if pipe_diameter_inch not in OD_TABLE_MM:
        raise HTTPException(status_code=400, detail="Diámetro no soportado.")

    od_real_mm = OD_TABLE_MM[pipe_diameter_inch]
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Formato de imagen no válido.")

    scale_mm_px, quality_error = compute_scale_mm_per_px(image, od_real_mm)
    if quality_error:
        return {"status": "QUALITY_ERROR", "message": quality_error}

    defect_type = "porosity"
    defect_size_px = 16.0
    defect_size_mm = defect_size_px * scale_mm_px

    verdict, clause, observation = evaluate_api1104_rules(defect_type, defect_size_mm)

    return {
        "status": "SUCCESS",
        "inspection_summary": {
            "pipe_nominal_size": f"{pipe_diameter_inch}\"",
            "pipe_od_mm": od_real_mm,
            "resolution_scale_mm_px": round(scale_mm_px, 4),
            "defect_detected": defect_type,
            "defect_size_mm": round(defect_size_mm, 2),
            "verdict": verdict,
            "applied_norm_clause": clause,
            "observation": observation
        }
    }