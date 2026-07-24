// ============================================================================
// CONFIGURACIÓN DE SEGURIDAD Y CONEXIÓN CORPORATIVA
// ============================================================================

// Clave de seguridad corporativa (Debe coincidir con COMPANY_API_KEY en main.py)
const COMPANY_API_KEY = "WeldSec2026_EmpresaPrivada_SecretKey!";
const BACKEND_API_URL = 'https://weld-inspection-system.onrender.com/v1/inspect';
// Elementos de la Interfaz Gráfica (DOM)
const webcamElement = document.getElementById('webcam');
const canvasElement = document.getElementById('snapshotCanvas');
const captureBtn = document.getElementById('captureBtn');
const pipeDiameterSelect = document.getElementById('pipeDiameter');
const loader = document.getElementById('loader');
const resultCard = document.getElementById('resultCard');
const retryBtn = document.getElementById('retryBtn');

// ============================================================================
// 1. INICIALIZACIÓN DE LA CÁMARA TRASERA
// ============================================================================
async function startCamera() {
    try {
        // Intentar acceder a la cámara trasera con alta resolución
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        webcamElement.srcObject = stream;
    } catch (err) {
        console.warn("Cámara trasera específica no detectada, utilizando la cámara principal por defecto:", err);
        try {
            // Fallback para computadoras o móviles con cámara única
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: false 
            });
            webcamElement.srcObject = fallbackStream;
        } catch (e) {
            alert("Error al inicializar la cámara: " + e.message);
        }
    }
}

// ============================================================================
// 2. CAPTURA Y ENVÍO SEGURO DE LA FOTO
// ============================================================================
captureBtn.addEventListener('click', async () => {
    const context = canvasElement.getContext('2d');
    canvasElement.width = webcamElement.videoWidth;
    canvasElement.height = webcamElement.videoHeight;
    
    // Extraer el fotograma actual del flujo de video
    context.drawImage(webcamElement, 0, 0, canvasElement.width, canvasElement.height);

    // Convertir a formato JPEG binario
    canvasElement.toBlob(async (blob) => {
        if (!blob) return;

        // Construir paquete multipart/form-data
        const formData = new FormData();
        formData.append('file', blob, 'weld_inspection.jpg');
        formData.append('pipe_diameter_inch', pipeDiameterSelect.value);

        // Actualizar estados visuales de la UI (Cargando...)
        captureBtn.style.display = 'none';
        loader.style.display = 'block';
        resultCard.style.display = 'none';

        try {
            // Enviar petición POST HTTPS con la clave privada corporativa en los headers
            const response = await fetch(BACKEND_API_URL, {
                method: 'POST',
                headers: {
                    'X-API-Key': COMPANY_API_KEY
                },
                body: formData
            });

            // Manejo de errores de autenticación/privacidad
            if (response.status === 403) {
                alert("🔒 Error de Seguridad: Acceso denegado. Clave corporativa no válida.");
                return;
            }

            if (!response.ok) {
                throw new Error(`Error en el servidor (${response.status})`);
            }

            const result = await response.json();
            displayResult(result);

        } catch (error) {
            alert("Error de comunicación con el servidor: " + error.message);
        } finally {
            loader.style.display = 'none';
            captureBtn.style.display = 'block';
        }
    }, 'image/jpeg', 0.92);
});

// ============================================================================
// 3. DESPLIEGUE DEL VEREDICTO API 1104 EN PANTALLA
// ============================================================================
function displayResult(res) {
    if (res.status === 'QUALITY_ERROR') {
        alert("⚠️ " + res.message);
        return;
    }

    const summary = res.inspection_summary;
    const verdictHeader = document.getElementById('verdictHeader');
    
    // Aplicar estilos según APROBADO / RECHAZADO
    resultCard.className = `card ${summary.verdict}`;
    verdictHeader.textContent = `VEREDICTO: ${summary.verdict}`;
    verdictHeader.style.color = summary.verdict === 'APROBADO' ? '#00e676' : '#ff1744';

    // Rellenar métricas obtenidas
    document.getElementById('resDefect').textContent = summary.defect_detected;
    document.getElementById('resSize').textContent = summary.defect_size_mm;
    document.getElementById('resScale').textContent = summary.resolution_scale_mm_px;
    document.getElementById('resClause').textContent = summary.applied_norm_clause;
    document.getElementById('resObservation').textContent = summary.observation;

    resultCard.style.display = 'block';
}

// Botón para reiniciar y tomar una nueva fotografía
retryBtn.addEventListener('click', () => {
    resultCard.style.display = 'none';
    captureBtn.style.display = 'block';
});

// Iniciar la cámara al cargar la página en el navegador
window.addEventListener('load', startCamera);