"""Local Russian speech-to-text fallback. Reads only audio bytes from stdin; emits JSON to stdout."""
import io
import json
import os
import sys
sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace')
import time
from pathlib import Path

def respond(payload, code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    return code

def main():
    audio=sys.stdin.buffer.read(24*1024*1024+1)
    if not audio or len(audio)>24*1024*1024:
        return respond({'ok': False, 'error': 'audio bytes outside supported range'},1)
    try:
        import av
        original_open=av.open
        # PyAV 16+ on Python 3.14 dropped metadata_errors, while faster-whisper still supplies it.
        def compatible_open(*args,**kwargs):
            kwargs.pop('metadata_errors',None)
            return original_open(*args,**kwargs)
        av.open=compatible_open
        from faster_whisper import WhisperModel
        root=Path(__file__).resolve().parents[3]
        model_id=os.environ.get('GIGORAVE_LOCAL_WHISPER_MODEL','small')
        model=WhisperModel(model_id,device='cpu',compute_type='int8',
            download_root=str(root/'data'/'local-speech-models'),local_files_only=True)
        started=time.monotonic()
        segments,info=model.transcribe(io.BytesIO(audio),language='ru',beam_size=5,
            temperature=0,vad_filter=True,condition_on_previous_text=False)
        text=' '.join(segment.text.strip() for segment in segments).strip()
        return respond({'ok':bool(text),'text':text,'model':'faster-whisper-'+model_id,
            'seconds':round(time.monotonic()-started,2),'language':info.language})
    except Exception as error:
        sys.stderr.write('LOCAL_STT_ERROR='+type(error).__name__+': '+str(error)[:200]+'\n')
        return respond({'ok':False,'error':type(error).__name__+': '+str(error)[:180]},1)

if __name__=='__main__':
    raise SystemExit(main())
