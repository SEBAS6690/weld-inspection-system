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

# Evitar advertencias de permisos en Render redirigiendo la configuración a /tmp
os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"

# Optimizar el consumo de CPU y memoria en servidores cloud
torch.set_num_threads(2)

# Parche de compatibilidad PyTorch 2.6+
try:
    from ultralytics.nn.tasks import DetectionModel
    torch.serialization.add_safe_globals([DetectionModel])
except Exception:
    pass

app = FastAPI(
    title="API de Inspección VT de Soldadura - API 1104",
    version="1.0.0"
)

# Configuración de CORS libre para permitir peticiones desde el frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cargar el modelo entrenado best.pt (Prioriza la carpeta backend/weights/best.pt)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "weights", "best.pt")

if os.path.exists(MODEL_PATH):
    model = YOLO(MODEL_PATH)
    print(f"✅ Modelo cargado correctamente desde: {MODEL_PATH}")
else:
    model = YOLO("yolov8n.pt")
    print("⚠️ ADVERTENCIA: 'best.pt' no encontrado. Cargando modelo nano por defecto.")

def convert_cv_to_base64(img_np):
    """
    Convierte una imagen de OpenCV (BGR) a una cadena Base64 optimizada en JPEG.
    """
    _, buffer = cv2.imencode('.jpg', img_np, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
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
    """
    Endpoint principal de inspección VT con evaluación bajo norma API 1104 Sec. 9.3.
    """
    try:
        contents = await file.read()
        pil_image = Image.open(io.BytesIO(contents)).convert('RGB')
        
        # Convertir imagen PIL a matriz BGR de OpenCV sin alterar la nitidez nativa
        img_np = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        h, w, _ = img_bgr.shape

        # 1. INFERENCIA CON EL MODELO ENTRENADO (Umbral estándar del 20%)
        with torch.no_grad():
            results = model(img_bgr, conf=0.20, imgsz=640)
        
        boxes = results[0].boxes

        # Criterio de tolerancia de la norma API 1104 Sec. 9.3
        max_allowed_mm = round(min(1.6, pipe_od_mm * 0.05), 2)

        verdict = "APROBADO"
        defect_type = "Ninguno / Cordón Sano"
        defect_size_mm = 0.0
        observations = "Cordón analizado sin discontinuidades críticas detectadas por la IA."
        
        annotated_img = img_bgr.copy()

        # 2. PROCESAMIENTO DE LAS DETECCIONES
        if len(boxes) > 0:
            # Obtener la box con la mayor confianza de detección
            best_box = max(boxes, key=lambda b: float(b.conf[0]))
            cls_id = int(best_box.cls[0])
            conf_val = float(best_box.conf[0])
            
            # Mapear el nombre asignado durante el entrenamiento en best.pt
            label_name = model.names[cls_id] if hasattr(model, 'names') and cls_id in model.names else f"Defecto_{cls_id}"
            
            x1, y1, x2, y2 = map(int, best_box.xyxy[0])
            box_w_px = x2 - x1
            box_h_px = y2 - y1

            # Conversión de píxeles a mm según el diámetro exterior (OD) de la tubería
            pixel_per_mm = (h * 0.8) / pipe_od_mm if pipe_od_mm > 0 else 1.0
            defect_size_mm = round(max(box_w_px, box_h_px) / pixel_per_mm, 2)
            defect_type = str(label_name).strip().capitalize()

            # Diagnóstico en los logs del servidor
            print(f"🔍 Detección realizada: Clase='{defect_type}', Confianza={conf_val:.2f}, Tamaño={defect_size_mm}mm")

            # Comprobar si la etiqueta pertenece a un cordón normal o sano
            is_healthy_label = defect_type.lower() in ["sano", "good", "cordon_sano", "ok", "normal", "good_weld"]

            # 3. VERDICTO DE ACEPTACIÓN O RECHAZO
            if not is_healthy_label or defect_size_mm > max_allowed_mm:
                verdict = "RECHAZADO"
                observations = f"Discontinuidad detectada: '{defect_type}' ({defect_size_mm} mm, Confianza: {int(conf_val * 100)}%). Evaluado según norma API 1104 Sec. 9.3 (Máx. permitido: {max_allowed_mm} mm)."
                box_color = (0, 0, 255) # Rojo (Rechazado)
            else:
                verdict = "APROBADO"
                observations = f"Registro detectado ('{defect_type}', {defect_size_mm} mm) dentro de los márgenes de tolerancia de la norma."
                box_color = (0, 255, 255) # Amarillo (Alerta/Tolerable)

            # Dibujar cuadro delimitador y etiqueta con clase + confianza sobre la imagen
            cv2.rectangle(annotated_img, (x1, y1), (x2, y2), box_color, 3)
            tag_text = f"{defect_type}: {defect_size_mm}mm ({int(conf_val * 100)}%)"
            (text_w, text_h), _ = cv2.getTextSize(tag_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            
            # Fondo para el texto superior
            cv2.rectangle(annotated_img, (x1, y1 - text_h - 10), (x1 + text_w + 10, y1), box_color, -1)
            cv2.putText(annotated_img, tag_text, (x1 + 5, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

        annotated_b64 = convert_cv_to_base64(annotated_img)

        # Liberación explícita de recursos en memoria RAM
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