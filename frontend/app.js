const webcamElement = document.getElementById('webcam');
const canvasElement = document.getElementById('snapshotCanvas');
const captureBtn = document.getElementById('captureBtn');
const pipeDiameterSelect = document.getElementById('pipeDiameter');
const loader = document.getElementById('loader');
const resultCard = document.getElementById('resultCard');
const retryBtn = document.getElementById('retryBtn');

// Cambia esta URL según la dirección IP de tu servidor FastAPI (para pruebas locales usa localhost)
const BACKEND_API_URL = 'http://localhost:8000/v1/inspect';

// 1. Inicializar la cámara trasera del teléfono inteligente
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: "environment" }, // Priorizar cámara trasera
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        webcamElement.srcObject = stream;
    } catch (err) {
        console.warn("No se pudo acceder a la cámara trasera, usando cámara por defecto:", err);
        // Fallback a cualquier cámara disponible si la trasera exacta no responde
        try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            webcamElement.srcObject = fallbackStream;
        } catch (e) {
            alert("Error al acceder a la cámara: " + e.message);
        }
    }
}

// 2. Capturar frame actual y enviar a la API
captureBtn.addEventListener('click', async () => {
    const context = canvasElement.getContext('2d');
    canvasElement.width = webcamElement.videoWidth;
    canvasElement.height = webcamElement.videoHeight;
    
    // Dibujar imagen actual en canvas
    context.drawImage(webcamElement, 0, 0, canvasElement.width, canvasElement.height);

    // Convertir canvas a Blob (JPEG)
    canvasElement.toBlob(async (blob) => {
        if (!blob) return;

        const formData = new FormData();
        formData.append('file', blob, 'weld_capture.jpg');
        formData.append('pipe_diameter_inch', pipeDiameterSelect.value);

        // Mostrar animación de carga
        captureBtn.style.display = 'none';
        loader.style.display = 'block';
        resultCard.style.display = 'none';

        try {
            const response = await fetch(BACKEND_API_URL, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            displayResult(result);
        } catch (error) {
            alert("Error al conectar con el servidor de inspección: " + error.message);
            captureBtn.style.display = 'block';
        } finally {
            loader.style.display = 'none';
        }
    }, 'image/jpeg', 0.9);
});

// 3. Desplegar los resultados de la inspección
function displayResult(res) {
    if (res.status === 'QUALITY_ERROR') {
        alert(res.message);
        captureBtn.style.display = 'block';
        return;
    }

    const summary = res.inspection_summary;
    const verdictHeader = document.getElementById('verdictHeader');
    
    resultCard.className = `card ${summary.verdict}`;
    verdictHeader.textContent = `VEREDICTO: ${summary.verdict}`;
    verdictHeader.style.color = summary.verdict === 'APROBADO' ? '#00e676' : '#ff1744';

    document.getElementById('resDefect').textContent = summary.defect_detected;
    document.getElementById('resSize').textContent = summary.defect_size_mm;
    document.getElementById('resScale').textContent = summary.resolution_scale_mm_px;
    document.getElementById('resClause').textContent = summary.applied_norm_clause;
    document.getElementById('resObservation').textContent = summary.observation;

    resultCard.style.display = 'block';
}

retryBtn.addEventListener('click', () => {
    resultCard.style.display = 'none';
    captureBtn.style.display = 'block';
});

// Arrancar cámara al cargar la página
window.addEventListener('load', startCamera);