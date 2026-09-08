$ErrorActionPreference = "Stop"
if (-not (Test-Path .venv)) { py -3.11 -m venv .venv }
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Write-Host "\nStarting transcription server on http://127.0.0.1:8765"
python -m uvicorn app:app --host 127.0.0.1 --port 8765
