FROM python:3.11-slim

# Instalar dependencias del sistema necesarias para OpenCV y gráficos
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar e instalar dependencias de Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el código del backend
COPY . .

# Exponer el puerto predeterminado
EXPOSE 8000

# Comando para arrancar FastAPI en producción
CMD ["uvicorn", "main.py:app", "--host", "0.0.0.0", "--port", "8000"]