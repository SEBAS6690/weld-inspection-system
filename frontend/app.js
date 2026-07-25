const BACKEND_URL = "https://weld-inspection-system.onrender.com";
let lastInspectionResult = null;

async function startCamera() {
    const videoElement = document.getElementById("webcamFeed");

    // Configuración progresiva: pide Full HD/4K ideal pero sin rechazar la cámara si no lo soporta
    const constraints = {
        video: {
            facingMode: { ideal: "environment" }, // Prioriza cámara trasera principal
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
        },
        audio: false
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = stream;

        // Intentar aplicar autoenfoque continuo en navegadores Android compatibles
        try {
            const track = stream.getVideoTracks()[0];
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
                await track.applyConstraints({
                    advanced: [{ focusMode: "continuous" }]
                });
            }
        } catch (e) {
            console.log("Autoenfoque avanzado no disponible, usando modo por defecto.");
        }

        await new Promise((resolve) => {
            videoElement.onloadedmetadata = () => resolve();
        });

        await videoElement.play();
        console.log(`📷 Cámara iniciada a: ${videoElement.videoWidth}x${videoElement.videoHeight}px`);

    } catch (error) {
        console.warn("Fallo con resolución 1080p, aplicando fallback estándar:", error);
        // Fallback básico para garantizar que SIEMPRE abra la cámara
        fallbackCamera();
    }
}

// Respaldo de emergencia en caso de restricciones de hardware
async function fallbackCamera() {
    try {
        const videoElement = document.getElementById("webcamFeed");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });
        videoElement.srcObject = stream;
        await videoElement.play();
    } catch (err) {
        alert("No se pudo acceder a la cámara. Por favor verifica que diste permisos de cámara en el navegador.");
    }
}

// Función de respaldo en caso de celulares antiguos o restricciones de navegador
async function fallbackCamera() {
    try {
        const videoElement = document.getElementById("webcamFeed");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });
        videoElement.srcObject = stream;
        await videoElement.play();
    } catch (e) {
        alert("No se pudo acceder a la cámara del dispositivo.");
    }
}

function captureFrameBlob() {
    return new Promise((resolve) => {
        const videoElement = document.getElementById("webcamFeed");
        const canvas = document.createElement("canvas");
        
        canvas.width = videoElement.videoWidth || 1280;
        canvas.height = videoElement.videoHeight || 720;
        
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });
}

async function takeInspectionPhoto() {
    const btnCapture = document.getElementById("btnCapture");
    btnCapture.disabled = true;
    btnCapture.innerText = "⏳ PROCESANDO...";

    try {
        const blob = await captureFrameBlob();
        const pipeOd = document.getElementById("pipeOd").value;

        const formData = new FormData();
        formData.append("file", blob, "weld.jpg");
        formData.append("pipe_od_mm", pipeOd);

        const response = await fetch(`${BACKEND_URL}/v1/inspect`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Error en el servidor backend");

        const data = await response.json();
        lastInspectionResult = data;
        displayResults(data);

    } catch (error) {
        alert("Error procesando inspección: " + error.message);
    } finally {
        btnCapture.disabled = false;
        btnCapture.innerText = "📸 ANALIZAR JUNTA";
    }
}

function displayResults(data) {
    document.getElementById("resultsSection").style.display = "block";
    const card = document.getElementById("resultsCard");
    const badge = document.getElementById("verdictBadge");

    card.className = "results-card " + (data.verdict === "APROBADO" ? "" : "rejected");
    badge.className = "verdict-badge " + (data.verdict === "APROBADO" ? "approved" : "rejected");
    badge.innerText = data.verdict;

    document.getElementById("annotatedImage").src = data.annotated_image;
    document.getElementById("defectType").innerText = data.defect_type;
    document.getElementById("defectSize").innerText = `${data.defect_size_mm} mm`;
    document.getElementById("maxAllowed").innerText = `${data.max_allowed_mm} mm`;
    document.getElementById("normClause").innerText = data.norm_clause;
    document.getElementById("observations").innerText = data.observations;
}

function openPdfModal() {
    document.getElementById("pdfModal").style.display = "flex";
}

function closePdfModal() {
    document.getElementById("pdfModal").style.display = "none";
}

async function downloadPDF() {
    if (!lastInspectionResult) {
        alert("Primero realiza un análisis para exportar el reporte.");
        return;
    }

    const inspectorName = document.getElementById("inspectorName").value.trim() || "Inspector No Registrado";
    const pipeTag = document.getElementById("pipeTag").value.trim() || "TAG-S/N";
    const pipeOd = document.getElementById("pipeOd").value;
    
    const videoElement = document.getElementById("webcamFeed");
    const cameraResolution = `${videoElement.videoWidth || 1280}x${videoElement.videoHeight || 720} px`;
    
    const now = new Date();
    const inspectionTime = now.toLocaleString("es-EC");

    const h = videoElement.videoHeight || 720;
    const pixelPerMm = (h * 0.8) / parseFloat(pipeOd);

    const formData = new FormData();
    formData.append("inspector_name", inspectorName);
    formData.append("inspection_time", inspectionTime);
    formData.append("pipe_tag", pipeTag);
    formData.append("pipe_od_mm", pipeOd);
    formData.append("camera_resolution", cameraResolution);
    formData.append("pixel_per_mm", pixelPerMm);

    formData.append("verdict", lastInspectionResult.verdict);
    formData.append("defect_type", lastInspectionResult.defect_type);
    formData.append("defect_size_mm", lastInspectionResult.defect_size_mm);
    formData.append("max_allowed_mm", lastInspectionResult.max_allowed_mm);
    formData.append("observations", lastInspectionResult.observations);
    formData.append("annotated_image_b64", lastInspectionResult.annotated_image);

    try {
        const response = await fetch(`${BACKEND_URL}/v1/export-pdf`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Error generando PDF");

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Reporte_VT_${pipeTag}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        closePdfModal();
    } catch (error) {
        alert("Error descargando el PDF: " + error.message);
    }
}

window.addEventListener("DOMContentLoaded", startCamera);