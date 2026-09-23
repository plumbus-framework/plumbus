FROM python:3.11-slim
WORKDIR /service
COPY requirements.txt .
# CPU reference image. GPU environments should provision their CUDA-compatible torch separately.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
COPY server.py .
RUN useradd --create-home laya \
    && mkdir -p /home/laya/.cache/huggingface \
    && chown -R laya:laya /home/laya/.cache
USER laya
ENV LAYA_HOST=0.0.0.0 LAYA_PORT=8080 LAYA_DEVICE=cpu HF_HOME=/home/laya/.cache/huggingface
EXPOSE 8080
CMD ["python", "server.py"]
