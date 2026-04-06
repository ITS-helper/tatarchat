Шаблоны для генерации картинок через ComfyUI (TatarChat).

1) В ComfyUI соберите рабочий граф (txt2img, img2img или inpaint).
2) Меню: Save (API Format) — сохраните JSON.
3) В полях промпта, негатива, размеров латента, KSampler и т.д. подставьте ТОЧНЫЕ строки-плейсхолдеры (как в документации env):
   <<<TC_PROMPT>>>   <<<TC_NEGATIVE>>>   <<<TC_STEPS>>>   <<<TC_WIDTH>>>   <<<TC_HEIGHT>>>
   <<<TC_SEED>>>   <<<TC_CFG>>>   <<<TC_DENOISE>>>   <<<TC_CHECKPOINT>>>
   Для img2img в узле Load Image вместо имени файла: <<<TC_LOAD_IMAGE>>>
   Для инпейнта во втором Load Image (маска): <<<TC_LOAD_MASK>>>
4) Положите файл в эту папку и укажите путь в .env:
   COMFY_TXT2IMG_WORKFLOW=comfy/workflows/имя.json
   COMFY_IMG2IMG_WORKFLOW=...   (опционально)
   COMFY_INPAINT_WORKFLOW=...   (опционально)
5) COMFYUI_BASE_URL=http://127.0.0.1:8000  (порт как в ComfyUI → Settings → Network)

Если в шаблоне есть <<<TC_CHECKPOINT>>>, задайте COMFY_DEFAULT_CHECKPOINT или выбирайте модель в интерфейсе сайта.
