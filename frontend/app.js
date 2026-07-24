/* ==========================================================================
   SISTEMA DE INSPECCIÓN VISUAL VT API 1104 - LÓGICA FRONTEND
   ========================================================================== */

// Configuración de Endpoints
const API_BASE_URL = "https://weld-inspection-system.onrender.com"; // Tu backend en Render

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
 * Inicia el flujo de la cámara trasera con enfoque continuo
 */
async function startCamera() {
    try {
        const constraints = {
            video: {
                facingMode: { ideal: "environment" }, // Prioriza la cámara trasera principal
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                focusMode: { ideal: "continuous" }   // Solicita autofoco continuo al hardware
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        webcamElement.srcObject = stream;

        // Configuración avanzada de enfoque según capacidades del sensor
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
        alert("No se pudo acceder a la cámara. Por favor, asegura los permisos e intenta nuevamente.");
    }
}

/**
 * Tap-to-Focus: Permite fijar el enfoque manualmente al tocar la imagen
 */
webcamElement.addEventListener('click', async () => {
    const track = webcamElement.srcObject?.getVideoTracks()[0];
    if (track && track.getCapabilities) {
        const caps = track.getCapabilities();
        if (caps.focusMode && caps.focusMode.includes('single-shot')) {
            try {
                await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
                console.log("Enfoque fijado manualmente.");
            } catch (e) {
                console.warn("Tap-to-focus no soportado en este dispositivo:", e);
            }
        }
    }
});

/**
 * Captura el fotograma actual con sincronización exacta de aspecto 4:3
 */
function captureFrameBlob() {
    return new Promise((resolve) => {
        const videoWidth = webcamElement.videoWidth;
        const videoHeight = webcamElement.videoHeight;

        // Calcular encuadre proporcional 4:3 idéntico al visor
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

        // Fijar dimensiones de captura de alta calidad
        canvas.width = 1280;
        canvas.height = 960;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(webcamElement, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
            resolve(blob);
        }, 'image/jpeg', 0.95);
    });
}

/**
 * Envía la captura al servidor Backend para inspección por IA
 */
async function processInspection() {
    const selectedOD = pipeDiameterSelect.value;
    if (!selectedOD) {
        alert("Por favor selecciona el Diámetro Nominal de la Tubería.");
        return;
    }

    // Estado UI: Procesando
    captureBtn.disabled = true;
    captureBtn.innerText = "⏳ ANALIZANDO CORTO Y DEFECTO...";
    resultsSection.style.display = "none";

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
            const errData = await response.json();
            throw new Error(errData.detail || "Error en el servidor de inspección.");
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
 * Despliega la tarjeta técnica con la imagen renderizada y el veredicto
 */
function renderResults(data) {
    const isApproved = data.verdict === "APROBADO";

    // Actualizar estilos de la tarjeta según dictamen API 1104
    resultsCard.className = `results-card ${isApproved ? 'approved' : 'rejected'}`;
    verdictBadge.className = `verdict-badge ${isApproved ? 'approved' : 'rejected'}`;
    verdictBadge.innerText = data.verdict;

    // Renderizar imagen anotada con el Bounding Box devuelto en Base64
    if (data.annotated_image) {
        resultImageContainer.innerHTML = `
            <h3>📷 DEFECTO ENMARCADO (IA):</h3>
            <img src="${data.annotated_image}" class="annotated-image" alt="Resultado de Inspección VT">
        `;
    } else {
        resultImageContainer.innerHTML = "";
    }

    // Ficha técnica descriptiva
    document.getElementById('resDefectType').innerText = data.defect_type || "N/A";
    document.getElementById('resDefectSize').innerText = data.defect_size_mm ? `${data.defect_size_mm} mm` : "N/A";
    document.getElementById('resMaxAllowed').innerText = data.max_allowed_mm ? `${data.max_allowed_mm} mm` : "N/A";
    document.getElementById('resNormClause').innerText = data.norm_clause || "API 1104 Sec. 9.3";
    document.getElementById('resObservations').innerText = data.observations || "Sin observaciones.";

    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Event Listeners
captureBtn.addEventListener('click', processInspection);

// Iniciar cámara al cargar la página
window.addEventListener('DOMContentLoaded', startCamera);