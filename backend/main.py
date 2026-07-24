from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from ultralytics import YOLO
import os

app = FastAPI(
    title="API 1104 Sistema de inspeccion de soldadura",
    description="Sistema de inspección visual de soldadura de tuberías bajo norma API 1104",
    version="1.0.0"
)

# Permitir solicitudes CORS desde la App Móvil / Frontend
# 🔒 CONFIGURACIÓN DE CORS PERMISIVA PARA NAVEGADORES MÓVILES Y VERCEL
# 🔒 CONFIGURACIÓN DE CORS COMPATIBLE CON VERCEL Y CLAVES PERSONALIZADAS
# 🔒 CONFIGURACIÓN DE CORS UNIVERSAL PARA VERCEL Y MÓVILES
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # Se cambia a False para permitir wildcard '*' con encabezados personalizados
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Tabla de Diámetros Exteriores Reales (OD) en mm (ASME B36.10M / API 5L)
OD_TABLE_MM = {
    "2": 60.3,
    "3": 88.9,
    "4": 114.3,
    "6": 168.3,
    "8": 219.1,
    "10": 273.1,
    "12": 323.9,
    "16": 406.4,
    "20": 508.0,
    "24": 610.0
}

# Cargar el modelo YOLOv8/v11 (se actualizará al terminar el entreno en Colab)
MODEL_PATH = "models/best.pt"
model = None
if os.path.exists(MODEL_PATH):
    model = YOLO(MODEL_PATH)


def compute_scale_mm_per_px(image: np.ndarray, od_real_mm: float):
    """
    Calcula la escala espacial (mm/px) midiendo el diámetro del tubo en la imagen.
    """
    h, w, _ = image.shape
    
    # Si tenemos modelo entrenado, segmentamos la tubería; de lo contrario usaremos estimación de ancho
    # Para la fase de pruebas MVP, tomamos el ancho dominante de la imagen (aprox. 80%)
    detected_pipe_diameter_px = w * 0.80  
    
    scale_mm_px = od_real_mm / detected_pipe_diameter_px
    px_per_mm = 1.0 / scale_mm_px
    
    # Criterio de densidad de resolución
    if px_per_mm < 3.0:
        return None, "Calidad insuficiente: La foto fue tomada muy lejos. Por favor acérquese a la soldadura."
        
    return scale_mm_px, None


def evaluate_api1104_rules(defect_type: str, size_mm: float):
    """
    Aplica las reglas de aceptación/rechazo visual de la norma API 1104 (Sección 9).
    """
    verdict = "APROBADO"
    clause = "API 1104 Sec. 9.3"
    observation = "El defecto detectado se encuentra dentro de los límites permisibles."

    defect_lower = defect_type.lower()

    if "porosity" in defect_lower or "poro" in defect_lower:
        # Poro aislado > 1.6 mm (1/16") se rechaza
        if size_mm > 1.6:
            verdict = "RECHAZADO"
            clause = "API 1104 Sec. 9.3.9 (Porosidad)"
            observation = f"Porosidad aislada de {size_mm:.2f} mm excede el tamaño máximo permitido (1.6 mm)."

    elif "undercut" in defect_lower or "socavado" in defect_lower:
        # Socavado > 0.8 mm de profundidad / ancho crítico
        if size_mm > 0.8:
            verdict = "RECHAZADO"
            clause = "API 1104 Sec. 9.3.11 (Socavado)"
            observation = f"Socavado de {size_mm:.2f} mm excede el límite permisible de profundidad/ancho."

    elif "crack" in defect_lower or "grieta" in defect_lower:
        # Cualquier grieta/fisura se rechaza automáticamente
        verdict = "RECHAZADO"
        clause = "API 1104 Sec. 9.3.1 (Fisuras/Grietas)"
        observation = "Se detectó fisuración en el cordón. Cero tolerancia bajo norma API 1104."

    return verdict, clause, observation


@app.post("/v1/inspect")
async def inspect_weld(
    pipe_diameter_inch: str = Form(..., description="Diámetro nominal de la tubería en pulgadas (ej: '8')"),
    file: UploadFile = File(...)
):
    if pipe_diameter_inch not in OD_TABLE_MM:
        raise HTTPException(
            status_code=400, 
            detail=f"Diámetro no soportado. Valores válidos: {list(OD_TABLE_MM.keys())}"
        )

    od_real_mm = OD_TABLE_MM[pipe_diameter_inch]
    
    # Leer archivo de imagen
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Formato de imagen no válido.")

    # 1. Calcular Escala Espacial mm/px
    scale_mm_px, quality_error = compute_scale_mm_per_px(image, od_real_mm)
    if quality_error:
        return {
            "status": "QUALITY_ERROR",
            "message": quality_error
        }

    # 2. Inferencia con Modelo de IA (o simulación previo al entreno en Colab)
    if model is not None:
        results = model(image)
        # Procesamiento de cajas / máscaras de YOLO aquí...
        defect_type = "porosity"
        defect_size_px = 18.5
    else:
        # Simulación mientras entrenamos en Colab
        defect_type = "porosity"
        defect_size_px = 16.0

    defect_size_mm = defect_size_px * scale_mm_px

    # 3. Evaluar con Norma API 1104
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)