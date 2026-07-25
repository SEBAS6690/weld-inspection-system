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