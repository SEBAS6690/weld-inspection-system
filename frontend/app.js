/* ==========================================================================
   SISTEMA DE INSPECCIÓN VISUAL VT API 1104 - LÓGICA FRONTEND
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

// Canvas oculto para procesar el frame
const canvas = document.createElement('canvas');

/**
 * Inicia la cámara con enfoque continuo
 */
async function startCamera() {
    try {
        const constraints = {
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                focusMode: { ideal: "continuous" }
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        webcamElement.srcObject = stream;

        // Reproducir video explícitamente
        await webcamElement.play().catch(() => {});

        const track = stream.getVideoTracks()[0];
        if (track && track.getCapabilities) {
            const capabilities = track.getCapabilities();
            if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                await track.applyConstraints({
                    advanced: [{ focusMode: 'continuous' }]
                });
            }
        }
    } catch (err) {
        console.error("Error al acceder a la cámara:", err);
        alert("No se pudo acceder a la cámara. Revisa los permisos e intenta de nuevo.");
    }
}

/**
 * Tap-to-Focus
 */
webcamElement.addEventListener('click', async () => {
    const track = webcamElement.srcObject?.getVideoTracks()[0];
    if (track && track.getCapabilities) {
        const caps = track.getCapabilities();
        if (caps.focusMode && caps.focusMode.includes('single-shot')) {
            try {
                await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
            } catch (e) {
                console.warn("Tap-to-focus no soportado:", e);
            }
        }
    }
});

/**
 * Captura el fotograma asegurando dimensiones válidas
 */
function captureFrameBlob() {
    return new Promise((resolve, reject) => {
        const videoWidth = webcamElement.videoWidth || 1280;
        const videoHeight = webcamElement.videoHeight || 960;

        if (!webcamElement.srcObject) {
            return reject(new Error("La cámara no está activa."));
        }

        const targetAspect = 4 / 3;
        const currentAspect = videoWidth / videoHeight;

        let sx, sy, sWidth, sHeight;

        if (currentAspect > targetAspect) {
            sHeight = videoHeight;
            sWidth = videoHeight * targetAspect;
            sx = (videoWidth - sWidth) / 2;
            sy = 0;
        } else {
            sWidth = videoWidth;
            sHeight = videoWidth / targetAspect;
            sx = 0;
            sy = (videoHeight - sHeight) / 2;
        }

        canvas.width = 1280;
        canvas.height = 960;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(webcamElement, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error("No se pudo generar la imagen desde la cámara."));
            }
        }, 'image/jpeg', 0.92);
    });
}

/**
 * Procesa la inspección enviando los datos al backend
 */
async function processInspection() {
    const selectedOD = pipeDiameterSelect ? pipeDiameterSelect.value : "114.3";
    
    if (!selectedOD) {
        alert("Por favor selecciona el Diámetro Nominal de la Tubería.");
        return;
    }

    // Cambiar estado visual del botón
    captureBtn.disabled = true;
    captureBtn.innerText = "⏳ ANALIZANDO JUNTA...";
    if (resultsSection) resultsSection.style.display = "none";

    try {
        const imageBlob = await captureFrameBlob();
        const formData = new FormData();
        formData.append("file", imageBlob, "inspection_frame.jpg");
        formData.append("pipe_od_mm", selectedOD);

        const response = await fetch(`${API_BASE_URL}/v1/inspect`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Error en el servidor (${response.status})`);
        }

        const data = await response.json();
        renderResults(data);

    } catch (error) {
        console.error("Error durante la inspección:", error);
        alert(`Error al procesar: ${error.message}`);
    } finally {
        captureBtn.disabled = false;
        captureBtn.innerText = "📸 CAPTURAR E INSPECCIONAR";
    }
}

/**
 * Muestra la tarjeta de resultados
 */
function renderResults(data) {
    if (!resultsSection) return;

    const isApproved = data.verdict === "APROBADO";

    if (resultsCard) resultsCard.className = `results-card ${isApproved ? 'approved' : 'rejected'}`;
    if (verdictBadge) {
        verdictBadge.className = `verdict-badge ${isApproved ? 'approved' : 'rejected'}`;
        verdictBadge.innerText = data.verdict;
    }

    if (resultImageContainer) {
        if (data.annotated_image) {
            resultImageContainer.innerHTML = `
                <h3>📷 DEFECTO ENMARCADO (IA):</h3>
                <img src="${data.annotated_image}" class="annotated-image" alt="Resultado de Inspección VT">
            `;
        } else {
            resultImageContainer.innerHTML = "";
        }
    }

    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
    };

    setEl('resDefectType', data.defect_type || "N/A");
    setEl('resDefectSize', data.defect_size_mm ? `${data.defect_size_mm} mm` : "N/A");
    setEl('resMaxAllowed', data.max_allowed_mm ? `${data.max_allowed_mm} mm` : "N/A");
    setEl('resNormClause', data.norm_clause || "API 1104 Sec. 9.3");
    setEl('resObservations', data.observations || "Sin observaciones.");

    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Event Listeners
if (captureBtn) captureBtn.addEventListener('click', processInspection);

window.addEventListener('DOMContentLoaded', startCamera);