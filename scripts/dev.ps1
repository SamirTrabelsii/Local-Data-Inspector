# Dev mode: API with auto-reload on :8765, Vite with HMR on :5173. Ctrl+C stops both.
$root = Split-Path -Parent $PSScriptRoot
$api = Start-Process -PassThru -NoNewWindow uv -ArgumentList 'run', '--directory', "$root\backend", 'ldi', '--no-browser', '--reload'
try {
    Start-Process 'http://localhost:5173'
    npm --prefix "$root\frontend" run dev
}
finally {
    Stop-Process -Id $api.Id -ErrorAction SilentlyContinue
}
