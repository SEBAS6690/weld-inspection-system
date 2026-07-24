// ==========================================================================
// LÓGICA FRONTEND - SISTEMA DE INSPECCIÓN API 1104
// ==========================================================================

const API_BASE_URL = "https://weld-inspection-system.onrender.com"; // Ajusta si tu dominio de Render varía
const API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!";

// Elementos del DOM
const webcamFeed = document.getElementById('webcamFeed');
const captureCanvas = document.getElementById('captureCanvas');
const captureBtn = document.getElementById('captureBtn');
const pipeSelect = document.getElementById('pipeSelect');
const resultsPanel = document.getElementById('resultsPanel');

// Inicializar la Cámara al Cargar la Página
async function initCamera() {
    try {
        const constraints = {
            video: {
                facingMode: { ideal: "environment" }, // Prioriza la cámara trasera en smartphones
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        webcamFeed.srcObject = stream;
    } catch (err) {
        console.error("Error al acceder a la cámara:", err);
        alert("No se pudo acceder a la cámara. Asegúrate de conceder los permisos correspondientes en el navegador.");
    }
}

// Capturar Imagen e Invocación a la API de Inspección
async function captureAndInspect() {
    if (!webcamFeed.srcObject) {
        alert("La cámara no está activa.");
        return;
    }

    // Configurar Canvas a la resolución nativa de la captura
    const width = webcamFeed.videoWidth || 1280;
    const height = webcamFeed.videoHeight || 720;
    captureCanvas.width = width;
    captureCanvas.height = height;

    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(webcamFeed, 0, 0, width, height);

    // Feedback visual en el botón
    captureBtn.disabled = true;
    captureBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> PROCESANDO IA...';

    // Convertir Canvas a imagen Blob (JPEG)
    captureCanvas.toBlob(async (blob) => {
        if (!blob) {
            alert("Error al procesar el fotograma de la cámara.");
            resetButton();
            return;
        }

        const formData = new FormData();
        formData.append('pipe_diameter_inch', pipeSelect.value);
        formData.append('file', blob, 'capture.jpg');

        try {
            const response = await fetch(`${API_BASE_URL}/v1/inspect`, {
                method: 'POST',
                headers: {
                    'X-API-Key': API_KEY
                },
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `Error HTTP: ${response.status}`);
            }

            const data = await response.json();
            displayResults(data);

        } catch (err) {
            console.error("Error en la inspección:", err);
            alert(`Error de comunicación: ${err.message}`);
        } finally {
            resetButton();
        }
    }, 'image/jpeg', 0.92);
}

// Desplegar Resultados y Renderizar Bounding Box de la Falla
function displayResults(data) {
    if (data.status === "QUALITY_ERROR") {
        alert("⚠️ Advertencia de Calidad:\n" + data.message);
        return;
    }

    const summary = data.inspection_summary;
    if (!summary) return;

    // 1. Mostrar Panel de Resultados
    resultsPanel.style.display = "block";
    
    // 2. Llenar Ficha Técnica
    document.getElementById('resPipe').innerText = summary.pipe_nominal_size;
    document.getElementById('resScale').innerText = `${summary.resolution_scale_mm_px} mm/px`;
    document.getElementById('resDefect').innerText = summary.defect_detected;
    document.getElementById('resSize').innerText = `${summary.defect_size_mm} mm`;
    document.getElementById('resClause').innerText = summary.applied_norm_clause;
    document.getElementById('resObs').innerText = summary.observation;

    // 3. Cargar Imagen Enmarcada Base64 desde el Backend
    const imgElem = document.getElementById('resAnnotatedImg');
    if (imgElem && summary.annotated_image) {
        imgElem.src = summary.annotated_image;
        imgElem.style.display = "block";
    } else if (imgElem) {
        imgElem.style.display = "none";
    }

    // 4. Formatear Indicadores y Tarjetas según el Veredicto
    const badge = document.getElementById('verdictBadge');
    const card = document.getElementById('resultsCard');

    badge.innerText = summary.verdict;

    if (summary.verdict === "APROBADO") {
        badge.className = "verdict-badge approved";
        card.className = "results-card";
    } else {
        badge.className = "verdict-badge rejected";
        card.className = "results-card rejected";
    }

    // 5. Desplazamiento automático al resultado
    resultsPanel.scrollIntoView({ behavior: 'smooth' });
}

// Restablecer Botón Principal
function resetButton() {
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i class="fa-solid fa-camera"></i> CAPTURAR E INSPECCIONAR';
}

// Event Listeners
captureBtn.addEventListener('click', captureAndInspect);
window.addEventListener('load', initCamera);