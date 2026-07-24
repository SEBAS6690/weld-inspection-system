// ==========================================================================
// CONFIGURACIÓN Y LÓGICA DE CAPTURA - API 1104 WELD INSPECTION SYSTEM
// ==========================================================================

const BACKEND_API_URL = 'https://weld-inspection-system.onrender.com/v1/inspect';

const video = document.getElementById('webcamFeed');
const canvas = document.getElementById('captureCanvas');
const captureBtn = document.getElementById('captureBtn');
const pipeSelect = document.getElementById('pipeSelect');
const resultsPanel = document.getElementById('resultsPanel');

// 1. Inicializar la Cámara
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" }, // Prioriza cámara trasera en teléfonos
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        video.srcObject = stream;
    } catch (err) {
        console.error("Error al acceder a la cámara:", err);
        alert("No se pudo acceder a la cámara. Asegúrate de dar los permisos correspondientes.");
    }
}

// 2. Evento del Botón "Capturar e Inspeccionar"
captureBtn.addEventListener('click', async () => {
    // Validar que el video esté listo y transmitiendo
    if (!video.videoWidth || !video.videoHeight) {
        alert("La cámara se está inicializando. Por favor, espera un segundo e intenta de nuevo.");
        return;
    }

    // Configurar dimensiones del canvas con la resolución real del video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Feedback visual para el usuario
    captureBtn.disabled = true;
    captureBtn.innerText = "Procesando con IA (API 1104)...";

    // Convertir la imagen del canvas a Blob (JPEG)
    canvas.toBlob(async (blob) => {
        if (!blob) {
            alert("Error al procesar la captura de la imagen.");
            resetButton();
            return;
        }

        const formData = new FormData();
        formData.append('pipe_diameter_inch', pipeSelect.value);
        formData.append('file', blob, 'weld_capture.jpg');

        try {
            const response = await fetch(BACKEND_API_URL, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || `Error en servidor: ${response.status}`);
            }

            const data = await response.json();
            displayResults(data);

        } catch (error) {
            console.error("Error en la inspección:", error);
            alert("Error de inspección: " + error.message);
        } finally {
            resetButton();
        }
    }, 'image/jpeg', 0.92);
});

// Restablecer el estado del botón
function resetButton() {
    captureBtn.disabled = false;
    captureBtn.innerText = "Capturar e Inspeccionar";
}

// 3. Renderizar los Resultados en Pantalla
function displayResults(data) {
    if (data.status === "QUALITY_ERROR") {
        alert("⚠️ Advertencia de Calidad:\n" + data.message);
        return;
    }

    const summary = data.inspection_summary;
    if (!summary) return;

    resultsPanel.style.display = "block";
    
    document.getElementById('resPipe').innerText = summary.pipe_nominal_size;
    document.getElementById('resScale').innerText = `${summary.resolution_scale_mm_px} mm/px`;
    document.getElementById('resDefect').innerText = summary.defect_detected;
    document.getElementById('resSize').innerText = `${summary.defect_size_mm} mm`;
    document.getElementById('resClause').innerText = summary.applied_norm_clause;
    document.getElementById('resObs').innerText = summary.observation;

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

    // Desplazar la vista suavemente hacia el resultado
    resultsPanel.scrollIntoView({ behavior: 'smooth' });
}

// Iniciar cámara al cargar la página
startCamera();