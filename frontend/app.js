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

/**
 * Inicia la transmisión de la cámara
 */
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        if (webcamElement) {
            webcamElement.srcObject = stream;
            await webcamElement.play().catch(() => {});
        }
    } catch (err) {
        console.error("Error al acceder a la cámara:", err);
        alert("No se pudo acceder a la cámara. Por favor concede los permisos correspondientes.");
    }
}

/**
 * Convierte el frame de la cámara a Blob JPEG de forma directa
 */
function captureFrameBlob() {
    return new Promise((resolve, reject) => {
        try {
            if (!webcamElement || !webcamElement.videoWidth) {
                return reject(new Error("La cámara no está lista o no transmite video."));
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
                    reject(new Error("Error al convertir la imagen para envío."));
                }
            }, 'image/jpeg', 0.85);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Procesa la inspección enviando la captura al backend
 */
async function processInspection() {
    console.log("Iniciando proceso de inspección...");
    
    const selectedOD = pipeDiameterSelect ? pipeDiameterSelect.value : "114.3";
    const userApiKey = (apiKeyInput && apiKeyInput.value.trim()) ? apiKeyInput.value.trim() : DEFAULT_API_KEY;

    if (captureBtn) {
        captureBtn.disabled = true;
        captureBtn.innerText = "⏳ ANALIZANDO JUNTA...";
    }

    try {
        // 1. Obtener imagen desde la cámara
        const imageBlob = await captureFrameBlob();
        
        // 2. Preparar datos
        const formData = new FormData();
        formData.append("file", imageBlob, "inspection_frame.jpg");
        formData.append("pipe_od_mm", selectedOD);

        // 3. Petición HTTP al Backend
        const response = await fetch(`${API_BASE_URL}/v1/inspect`, {
            method: "POST",
            headers: {
                "X-API-Key": userApiKey
            },
            body: formData
        });

        if (!response.ok) {
            const errDetail = await response.text();
            throw new Error(`Respuesta del servidor (${response.status}): ${errDetail}`);
        }

        const data = await response.json();
        console.log("Datos recibidos:", data);
        
        // 4. Desplegar resultados
        renderResults(data);

    } catch (error) {
        console.error("Error detectado:", error);
        alert(`Atención: ${error.message}`);
    } finally {
        if (captureBtn) {
            captureBtn.disabled = false;
            captureBtn.innerText = "📸 CAPTURAR E INSPECCIONAR";
        }
    }
}

/**
 * Renderiza la tarjeta de evaluación API 1104
 */
function renderResults(data) {
    if (!resultsSection) {
        alert("Error de interfaz: No se encontró la sección de resultados en el HTML.");
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

// Vinculación explícita del evento al cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
    startCamera();
    if (captureBtn) {
        captureBtn.onclick = processInspection;
    }
});