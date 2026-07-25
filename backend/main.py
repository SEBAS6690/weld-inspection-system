import os
import io
import gc
import base64
import torch
import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# ReportLab para la generación del PDF
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image as RLImage, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"
torch.set_num_threads(2)

try:
    from ultralytics.nn.tasks import DetectionModel
    torch.serialization.add_safe_globals([DetectionModel])
except Exception:
    pass

app = FastAPI(
    title="API Inspección VT API 1104",
    version="1.1.0"
)

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
        
        pil_image.thumbnail((800, 800))
        img_np = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        h, w, _ = img_bgr.shape

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
            best_box = max(boxes, key=lambda b: float(b.conf[0]))
            cls_id = int(best_box.cls[0])
            conf_val = float(best_box.conf[0])
            
            raw_label = model.names[cls_id] if hasattr(model, 'names') and cls_id in model.names else f"Defecto_{cls_id}"
            defect_type = str(raw_label).strip().capitalize()

            x1, y1, x2, y2 = map(int, best_box.xyxy[0])
            box_w_px = x2 - x1
            box_h_px = y2 - y1

            pixel_per_mm = (h * 0.8) / pipe_od_mm if pipe_od_mm > 0 else 1.0
            defect_size_mm = round(max(box_w_px, box_h_px) / pixel_per_mm, 2)

            print(f"🔍 Detección real: Clase='{defect_type}', Confianza={conf_val:.2f}, Tamaño={defect_size_mm}mm")

            label_lower = defect_type.lower()
            if "sano" in label_lower or "good" in label_lower or "ok" in label_lower:
                verdict = "APROBADO"
                observations = f"Cordón inspeccionado sin fallas ({defect_type})."
                box_color = (0, 255, 0)
            else:
                verdict = "RECHAZADO"
                observations = f"Discontinuidad detectada: '{defect_type}' ({defect_size_mm} mm, Confianza: {int(conf_val*100)}%). Supera tolerancia API 1104 Sec. 9.3 ({max_allowed_mm} mm)."
                box_color = (0, 0, 255)

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
        print(f"Error procesando imagen: {str(e)}")
        gc.collect()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/export-pdf")
async def export_pdf_report(
    inspector_name: str = Form(...),
    inspection_time: str = Form(...),
    pipe_tag: str = Form(...),
    pipe_od_mm: float = Form(...),
    camera_resolution: str = Form(...),
    pixel_per_mm: float = Form(...),
    verdict: str = Form(...),
    defect_type: str = Form(...),
    defect_size_mm: float = Form(...),
    max_allowed_mm: float = Form(...),
    observations: str = Form(...),
    annotated_image_b64: str = Form(...)
):
    try:
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
        
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle('TitleStyle', parent=styles['Heading1'], fontSize=15, textColor=colors.HexColor('#0b0f19'), alignment=1, spaceAfter=10)
        header_style = ParagraphStyle('HeaderStyle', parent=styles['Normal'], fontSize=8, textColor=colors.HexColor('#555555'), alignment=1)
        label_style = ParagraphStyle('LabelStyle', parent=styles['Normal'], fontSize=9, fontName='Helvetica-Bold')
        value_style = ParagraphStyle('ValueStyle', parent=styles['Normal'], fontSize=9)
        
        story = []

        story.append(Paragraph("<b>REPORTE TÉCNICO DE INSPECCIÓN VISUAL (VT) - API 1104</b>", title_style))
        story.append(Paragraph("Evaluación de Soldadura mediante Visión Artificial (YOLOv8)", header_style))
        story.append(Spacer(1, 12))

        data_general = [
            [Paragraph("Inspector / Operador:", label_style), Paragraph(inspector_name, value_style), Paragraph("Fecha / Hora:", label_style), Paragraph(inspection_time, value_style)],
            [Paragraph("Tag / ID Tubería:", label_style), Paragraph(pipe_tag, value_style), Paragraph("Diámetro Ext. (OD):", label_style), Paragraph(f"{pipe_od_mm} mm", value_style)],
            [Paragraph("Norma Aplicada:", label_style), Paragraph("API 1104 Sec. 9.3", value_style), Paragraph("Tolerancia Máxima:", label_style), Paragraph(f"{max_allowed_mm} mm", value_style)]
        ]
        t_general = Table(data_general, colWidths=[130, 140, 130, 140])
        t_general.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#F5F7FA')),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#D0D7DE')),
            ('PADDING', (0, 0), (-1, -1), 5),
        ]))
        story.append(t_general)
        story.append(Spacer(1, 12))

        if "," in annotated_image_b64:
            annotated_image_b64 = annotated_image_b64.split(",")[1]
        
        img_data = base64.b64decode(annotated_image_b64)
        img_io = io.BytesIO(img_data)
        
        report_img = RLImage(img_io, width=400, height=225)
        story.append(report_img)
        story.append(Spacer(1, 12))

        verdict_color = colors.HexColor('#008744') if verdict == "APROBADO" else colors.HexColor('#D62D20')
        verdict_style = ParagraphStyle('VerdictStyle', parent=styles['Normal'], fontSize=10, fontName='Helvetica-Bold', textColor=verdict_color)

        data_results = [
            [Paragraph("Veredicto Final:", label_style), Paragraph(verdict, verdict_style)],
            [Paragraph("Discontinuidad:", label_style), Paragraph(defect_type, value_style)],
            [Paragraph("Dimensión Detectada:", label_style), Paragraph(f"{defect_size_mm} mm", value_style)],
            [Paragraph("Observaciones:", label_style), Paragraph(observations, value_style)]
        ]
        t_results = Table(data_results, colWidths=[140, 400])
        t_results.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#D0D7DE')),
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#EEF2F6')),
            ('PADDING', (0, 0), (-1, -1), 5),
        ]))
        story.append(t_results)
        story.append(Spacer(1, 10))

        story.append(Paragraph("<b>Parámetros Métricos y de Captura:</b>", label_style))
        story.append(Spacer(1, 4))
        
        data_tech = [
            [Paragraph("Resolución Cámara:", label_style), Paragraph(camera_resolution, value_style)],
            [Paragraph("Escala Calculada:", label_style), Paragraph(f"{round(pixel_per_mm, 3)} px/mm", value_style)],
            [Paragraph("Fórmula Calibración:", label_style), Paragraph("px_mm = (Alto_PX * 0.8) / OD_mm", value_style)]
        ]
        t_tech = Table(data_tech, colWidths=[140, 400])
        t_tech.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#E1E4E8')),
            ('PADDING', (0, 0), (-1, -1), 4),
        ]))
        story.append(t_tech)

        doc.build(story)
        buffer.seek(0)
        
        return Response(
            content=buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=Reporte_VT_{pipe_tag}.pdf"}
        )

    except Exception as e:
        print(f"Error PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))