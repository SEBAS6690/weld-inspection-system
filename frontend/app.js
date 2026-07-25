/* ==========================================================================
   SISTEMA DE INSPECCIÓN VISUAL VT API 1104 - FRONTEND LIBRE DE CREDENCIALES
   ========================================================================== */

const API_BASE_URL = "https://weld-inspection-system.onrender.com";

// Elementos del DOM
const webcamElement = document.getElementById('webcamFeed');
const pipeDiameterSelect = document.getElementById('pipeDiameter');
const captureBtn = document.getElementById('captureBtn');
const resultsSection = document.getElementById('resultsSection');
const resultsCard = document.getElementById('resultsCard');
const verdictBadge = document.getElementById('verdictBadge');
const resultImageContainer = document.getElementById('resultImageContainer');

/**
 * Activa el video de la cámara
 */
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                aspectRatio: { ideal: 1.777777778 }
            }
        });
        if (webcamElement) {
            webcamElement.srcObject = stream;
            await webcamElement.play().catch(() => {});
        }
    } catch (err) {
        console.error("Error de cámara:", err);
        alert("No se pudo iniciar la cámara. Concede los permisos en el navegador.");
    }
}

/**
 * Extrae la foto actual de la cámara como un archivo ejecutable Blob JPEG
 */
function captureFrameBlob() {
    return new Promise((resolve, reject) => {
        try {
            if (!webcamElement || !webcamElement.videoWidth) {
                return reject(new Error("La cámara no está enviando señal de video."));
            }

            const canvas = document.createElement('canvas');
            canvas.width = webcamElement.videoWidth || 1280;
            canvas.height = webcamElement.videoHeight || 720;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(webcamElement, 0, 0, canvas.width, canvas.height);

            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error("No se logró procesar la captura de la cámara."));
                }
            }, 'image/jpeg', 0.85);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Petición de inspección sin encabezados de autenticación
 */
async function processInspection() {
    const selectedOD = pipeDiameterSelect ? pipeDiameterSelect.value : "114.3";

    if (captureBtn) {
        captureBtn.disabled = true;
        captureBtn.innerText = "⏳ ANALIZANDO JUNTA...";
    }

    try {
        const imageBlob = await captureFrameBlob();
        const formData = new FormData();
        formData.append("file", imageBlob, "inspection_frame.jpg");
        formData.append("pipe_od_mm", selectedOD);

        // Envío directo al servidor
        const response = await fetch(`${API_BASE_URL}/v1/inspect`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`El servidor falló con código ${response.status}: ${errText}`);
        }

        const data = await response.json();
        renderResults(data);

    } catch (error) {
        console.error("Error en inspección:", error);
        alert(`Atención: ${error.message}`);
    } finally {
        if (captureBtn) {
            captureBtn.disabled = false;
            captureBtn.innerText = "📸 CAPTURAR E INSPECCIONAR";
        }
    }
}

/**
 * Renderiza el reporte visual
 */
function renderResults(data) {
    if (!resultsSection) return;

    const verdict = data.verdict || "APROBADO";
    const isApproved = verdict === "APROBADO";

    if (resultsCard) resultsCard.className = `results-card ${isApproved ? 'approved' : 'rejected'}`;
    if (verdictBadge) {
        verdictBadge.className = `verdict-badge ${isApproved ? 'approved' : 'rejected'}`;
        verdictBadge.innerText = verdict;
    }

    if (resultImageContainer) {
        if (data.annotated_image) {
            resultImageContainer.innerHTML = `
                <h3 style="margin-top:15px; color:#fff;">📷 DEFECTO ENMARCADO (IA):</h3>
                <img src="${data.annotated_image}" style="width:100%; border-radius:8px; margin-top:8px;" alt="Resultado Inspección">
            `;
        } else {
            resultImageContainer.innerHTML = "";
        }
    }

    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
    };

    setEl('resDefectType', data.defect_type || "Ninguno / Cordón Sano");
    setEl('resDefectSize', data.defect_size_mm !== undefined ? `${data.defect_size_mm} mm` : "0.0 mm");
    setEl('resMaxAllowed', data.max_allowed_mm !== undefined ? `${data.max_allowed_mm} mm` : "N/A");
    setEl('resNormClause', data.norm_clause || "API 1104 Sec. 9.3");
    setEl('resObservations', data.observations || "Sin observaciones.");

    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Escuchador de arranque
document.addEventListener('DOMContentLoaded', () => {
    startCamera();
    if (captureBtn) {
        captureBtn.onclick = processInspection;
    }
});

// Variable global para guardar los datos de la última inspección realizada
let lastInspectionResult = null;

// Llamar al endpoint de PDF al hacer clic en Exportar
async function downloadPDF() {
    const inspectorName = document.getElementById("inspectorName").value.trim() || "Inspector No Registrado";
    const pipeTag = document.getElementById("pipeTag").value.trim() || "TAG-S/N";
    
    const videoElement = document.getElementById("webcamFeed");
    const cameraResolution = `${videoElement.videoWidth || 1280}x${videoElement.videoHeight || 720} px`;
    
    const now = new Date();
    const inspectionTime = now.toLocaleString("es-EC");

    // Construir FormData con los resultados actuales y los datos del formulario
    const formData = new FormData();
    formData.append("inspector_name", inspectorName);
    formData.append("inspection_time", inspectionTime);
    formData.append("pipe_tag", pipeTag);
    formData.append("pipe_od_mm", document.getElementById("pipeOd").value);
    formData.append("camera_resolution", cameraResolution);
    
    // Cálculo del factor píxel/mm
    const h = videoElement.videoHeight || 720;
    const pipeOd = parseFloat(document.getElementById("pipeOd").value);
    const pixelPerMm = (h * 0.8) / pipeOd;
    formData.append("pixel_per_mm", pixelPerMm);

    // Datos del resultado del análisis
    formData.append("verdict", lastInspectionResult.verdict);
    formData.append("defect_type", lastInspectionResult.defect_type);
    formData.append("defect_size_mm", lastInspectionResult.defect_size_mm);
    formData.append("max_allowed_mm", lastInspectionResult.max_allowed_mm);
    formData.append("observations", lastInspectionResult.observations);
    formData.append("annotated_image_b64", lastInspectionResult.annotated_image);

    try {
        const response = await fetch("https://tu-backend.onrender.com/v1/export-pdf", {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Error generando PDF");

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Reporte_VT_${pipeTag}_${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        closePdfModal();
    } catch (error) {
        alert("Error al descargar el PDF: " + error.message);
    }
}

function openPdfModal() {
    document.getElementById("pdfModal").style.display = "flex";
}

function closePdfModal() {
    document.getElementById("pdfModal").style.display = "none";
}