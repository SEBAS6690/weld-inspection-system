import os
import io
import base64
import torch
import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# ==============================================================================
# CONFIGURACIÓN DE SEGURIDAD Y PARCHE DE COMPATIBILIDAD PYTORCH 2.6+
# ==============================================================================
# Clave privada corporativa permitida
VALID_API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!"

# Parche para la deserialización segura de modelos YOLOv8 en PyTorch 2.6+
try:
    from ultralytics.nn.tasks import DetectionModel
    torch.serialization.add_safe_globals([DetectionModel])
except Exception as e:
    print(f"Aviso de parche PyTorch: {e}")

# ==============================================================================
# INICIALIZACIÓN DE LA APLICACIÓN Y MODELO IA
# ==============================================================================
app = FastAPI(
    title="API de Inspección VT de Soldadura - API 1104",
    version="1.0.0"
)

# Habilitar CORS para permitir peticiones desde Vercel
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cargar el modelo de IA YOLOv8 entrenado para defectos de soldadura
MODEL_PATH = os.path.join(os.path.dirname(__file__), "weights", "best.pt")

if os.path.exists(MODEL_PATH):
    model = YOLO(MODEL_PATH)
    print(f"Modelo cargado correctamente desde: {MODEL_PATH}")
else:
    # Carga de modelo base en caso de no encontrar pesos personalizados
    model = YOLO("yolov8n.pt")
    print("ADVERTENCIA: Usando modelo YOLOv8 por defecto (best.pt no encontrado).")

# ==============================================================================
# FUNCIONES AUXILIARES DE PROCESAMIENTO
# ==============================================================================
def verify_api_key(x_api_key: str = Header(None), authorization: str = Header(None)):
    """
    Verifica la credencial enviada en los encabezados HTTP.
    Soporta X-API-Key o Bearer Token.
    """
    token = x_api_key
    if not token and authorization:
        token = authorization.replace("Bearer ", "").strip()
    
    # Validación permisiva: Acepta la clave predeterminada o cualquier valor no vacío durante pruebas
    if not token or (token != VALID_API_KEY and token != "WeldSec2026_EmpresaPrivada_SecretKey!"):
        # Si deseas desactivar totalmente la validación en desarrollo, omite este raise
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Acceso denegado: Credencial privada corporativa no válida."
        )
    return True

def convert_cv_to_base64(img_np):
    """
    Convierte una imagen de OpenCV (BGR) a una cadena Base64 lista para HTML.
    """
    _, buffer = cv2.imencode('.jpg', img_np, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_str}"

# ==============================================================================
# ENDPOINTS DE LA API
# ==============================================================================
@app.get("/")
def read_root():
    return {
        "status": "ONLINE",
        "system": "Sistema de Inspección VT API 1104",
        "version": "1.0.0"
    }

@app.post("/v1/inspect")
async def inspect_weld(
    file: UploadFile = File(...),
    pipe_od_mm: float = Form(...),
    x_api_key: str = Header(None),
    authorization: str = Header(None)
):
    """
    Endpoint principal para inspeccionar el cordón de soldadura.
    Procesa la imagen, detecta discontinuidades, aplica criterio API 1104 
    y devuelve la imagen anotada en formato Base64.
    """
    # 1. Validar autenticación
    verify_api_key(x_api_key, authorization)

    try:
        # 2. Leer archivo enviado por el usuario
        contents = await file.read()
        pil_image = Image.open(io.BytesIO(contents)).convert('RGB')
        img_np = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)

        h, w, _ = img_bgr.shape

        # 3. Inferencia con YOLOv8
        results = model(img_bgr, conf=0.25)
        boxes = results[0].boxes

        # Límites máximos admisibles según API 1104 Sec. 9.3 (Criterio para tubos estándar)
        # Porosidad aislada / Discontinuidad individual <= 1.6 mm o 1/8 de pulgada
        max_allowed_mm = round(min(1.6, pipe_od_mm * 0.05), 2)

        verdict = "APROBADO"
        defect_type = "Ninguno / Cordón Sano"
        defect_size_mm = 0.0
        observations = "Cordón libre de discontinuidades críticas dentro de los parámetros de la norma."
        annotated_b64 = None

        # Copia para dibujar las anotaciones en alta visibilidad
        annotated_img = img_bgr.copy()

        if len(boxes) > 0:
            # Obtener el defecto con mayor confianza
            best_box = max(boxes, key=lambda b: float(b.conf[0]))
            cls_id = int(best_box.cls[0])
            label_name = model.names[cls_id] if hasattr(model, 'names') else "Porosidad / Fusión Incompleta"
            
            # Coordenadas de la caja delimitadora (x1, y1, x2, y2)
            x1, y1, x2, y2 = map(int, best_box.xyxy[0])
            box_w_px = x2 - x1
            box_h_px = y2 - y1

            # Factor de conversión espacial Pixeles -> Milímetros basado en el OD nominal
            # Asumiendo que el diámetro ocupa aproximadamente el 80% del alto del visor
            pixel_per_mm = (h * 0.8) / pipe_od_mm if pipe_od_mm > 0 else 1.0
            defect_size_mm = round(max(box_w_px, box_h_px) / pixel_per_mm, 2)

            defect_type = label_name.capitalize()

            # Evaluación de rechazo por API 1104
            if defect_size_mm > max_allowed_mm:
                verdict = "RECHAZADO"
                observations = f"Discontinuidad del tipo '{defect_type}' supera la tolerancia máxima admisible por API 1104 ({max_allowed_mm} mm)."
                box_color = (0, 0, 255) # Rojo Neón para Rechazado
            else:
                verdict = "APROBADO"
                observations = f"Discontinuidad leve detectada ({defect_type}), se encuentra dentro del rango tolerable."
                box_color = (0, 255, 255) # Amarillo Neón para Alerta

            # Dibujar Bounding Box de alto contraste y etiqueta en la imagen
            cv2.rectangle(annotated_img, (x1, y1), (x2, y2), box_color, 3)
            
            # Etiqueta sobre el cuadro
            tag_text = f"{defect_type}: {defect_size_mm}mm"
            (text_w, text_h), _ = cv2.getTextSize(tag_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            cv2.rectangle(annotated_img, (x1, y1 - text_h - 10), (x1 + text_w + 10, y1), box_color, -1)
            cv2.putText(annotated_img, tag_text, (x1 + 5, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

            annotated_b64 = convert_cv_to_base64(annotated_img)
        else:
            # Si no hay defectos, retornar la imagen original procesada
            annotated_b64 = convert_cv_to_base64(img_bgr)

        # 4. Respuesta estructurada JSON
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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error interno durante la inspección: {str(e)}"
        )