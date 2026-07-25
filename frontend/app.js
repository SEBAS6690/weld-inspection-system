/* ==========================================================================
   SISTEMA DE INSPECCIÓN VISUAL VT API 1104 - LÓGICA FRONTEND
   ========================================================================== */

const API_BASE_URL = "https://weld-inspection-system.onrender.com";
const DEFAULT_API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!";

// Elementos del DOM
const webcamElement = document.getElementById('webcamFeed');
const pipeDiameterSelect = document.getElementById('pipeDiameter');
const apiKeyInput = document.getElementById('apiKeyInput');
const captureBtn = document.getElementById('captureBtn');
const resultsSection = document.getElementById('resultsSection');
const resultsCard = document.getElementById('resultsCard');
const verdictBadge = document.getElementById('verdictBadge');
const resultImageContainer = document.getElementById('resultImageContainer');

// Canvas oculto para procesar el fotograma
const canvas = document.createElement('canvas');

/**
 * Inicia el stream de la cámara trasera priorizando enfoque continuo
 */
async function startCamera() {
    try {
        const constraints = {
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                focusMode: { ideal: "continuous" }
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        webcamElement.srcObject = stream;
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
        alert("No se pudo acceder a la cámara. Asegúrate de conceder los permisos e intenta nuevamente.");
    }
}

/**
 * Captura el fotograma actual garantizando relación de aspecto 4:3
 */
function captureFrameBlob() {
    return new Promise((resolve, reject) => {
        const videoWidth = webcamElement.videoWidth || 1280;
        const videoHeight = webcamElement.videoHeight || 960;

        if (!webcamElement.srcObject) {
            return reject(new Error("La cámara no se encuentra activa."));
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
                reject(new Error("No se pudo generar la captura desde la cámara."));
            }
        }, 'image/jpeg', 0.85);
    });
}

/**
 * Envía la captura e información técnica al backend para análisis con YOLOv8
 */
async function processInspection() {
    const selectedOD = pipeDiameterSelect ? pipeDiameterSelect.value : "114.3";
    const userApiKey = apiKeyInput && apiKeyInput.value.trim() ? apiKeyInput.value.trim() : DEFAULT_API_KEY;

    if (!selectedOD) {
        alert("Por favor selecciona el Diámetro Nominal de la Tubería.");
        return;
    }

    // Actualizar estado visual de la UI
    captureBtn.disabled = true;
    captureBtn.innerText = "⏳ ANALIZANDO JUNTA...";

    try {
        const imageBlob = await captureFrameBlob();
        const formData = new FormData();
        formData.append("file", imageBlob, "inspection_frame.jpg");
        formData.append("pipe_od_mm", selectedOD);

        // Petición con timeout manual de 20 segundos
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(`${API_BASE_URL}/v1/inspect`, {
            method: "POST",
            headers: {
                "X-API-Key": userApiKey
            },
            body: formData,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Servidor respondió con código ${response.status}: ${errText}`);
        }

        const data = await response.json();
        console.log("Respuesta recibida del backend:", data);

        renderResults(data);

    } catch (error) {
        console.error("Error durante la inspección:", error);
        if (error.name === 'AbortError') {
            alert("El servidor en Render tardó demasiado en responder (Timeout). Por favor intenta presionar el botón de nuevo.");
        } else {
            alert(`Error al procesar la inspección: ${error.message}`);
        }
    } finally {
        captureBtn.disabled = false;
        captureBtn.innerText = "📸 CAPTURAR E INSPECCIONAR";
    }
}

/**
 * Muestra el informe de evaluación bajo norma API 1104
 */
function renderResults(data) {
    if (!resultsSection) {
        console.error("El elemento 'resultsSection' no existe en el DOM.");
        return;
    }

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
                <img src="${data.annotated_image}" class="annotated-image" style="width:100%; border-radius:8px; margin-top:8px;" alt="Resultado VT">
            `;
        } else {
            resultImageContainer.innerHTML = "<p style='color:#aaa;'>Sin imagen renderizada.</p>";
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

    // Desplegar sección de resultados
    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Escuchadores de eventos
if (captureBtn) captureBtn.addEventListener('click', processInspection);

window.addEventListener('DOMContentLoaded', startCamera);