import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "data" / "config.json"
TILE_SIZE = 512
Image.MAX_IMAGE_PIXELS = None


def relative_path(path):
    return path.resolve().relative_to(ROOT).as_posix()


def make_tiles(source_path, output_path, level_count):
    if not features.check("webp"):
        raise RuntimeError("Эта сборка Pillow не поддерживает WebP.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = Path(tempfile.mkdtemp(prefix=".tiles-", dir=output_path.parent))
    image = None
    try:
        image = Image.open(source_path)
        image.load()
        source_width, source_height = image.size
        if image.mode not in ("RGB", "RGBA"):
            converted = image.convert("RGBA" if "transparency" in image.info else "RGB")
            image.close()
            image = converted

        current = image
        for level in range(level_count):
            if level:
                next_image = current.resize(
                    (max(1, math.ceil(current.width / 2)), max(1, math.ceil(current.height / 2))),
                    Image.Resampling.LANCZOS,
                )
                current.close()
                current = next_image

            level_path = temp_path / str(level)
            level_path.mkdir()
            columns = math.ceil(current.width / TILE_SIZE)
            rows = math.ceil(current.height / TILE_SIZE)
            for row in range(rows):
                top = row * TILE_SIZE
                for column in range(columns):
                    left = column * TILE_SIZE
                    tile = current.crop((left, top, min(left + TILE_SIZE, current.width), min(top + TILE_SIZE, current.height)))
                    tile.save(level_path / f"{column}_{row}.webp", "WEBP", quality=82, method=4)
                    tile.close()

            print(f"Уровень {level + 1}/{level_count}: {columns * rows} тайлов", flush=True)

        if current is not None:
            current.close()
            image = None

        manifest = {
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "tileSize": TILE_SIZE,
            "levels": level_count,
            "format": "webp",
        }
        (temp_path / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        backup_path = output_path.with_name(output_path.name + ".previous")
        if backup_path.exists():
            shutil.rmtree(backup_path)
        if output_path.exists():
            output_path.rename(backup_path)
        temp_path.rename(output_path)
        if backup_path.exists():
            shutil.rmtree(backup_path)
        return source_width, source_height
    except Exception:
        if image is not None:
            image.close()
        if temp_path.exists():
            shutil.rmtree(temp_path, ignore_errors=True)
        raise


def main():
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    modes = config.get("modes", [])
    parser = argparse.ArgumentParser(description="Автоматически создаёт тайлы карты и подключает их к режимам атласа.")
    parser.add_argument("image", type=Path, help="Исходное изображение карты")
    parser.add_argument("--mode", help="Режим карты для нового файла, например geographical")
    args = parser.parse_args()

    source_path = args.image.expanduser().resolve()
    if not source_path.is_file():
        parser.error(f"Файл не найден: {source_path}")

    selected_mode = next((mode for mode in modes if mode.get("id") == args.mode), None) if args.mode else None
    if args.mode and selected_mode is None:
        parser.error(f"Неизвестный режим: {args.mode}")

    if not source_path.is_relative_to(ROOT):
        if selected_mode is None:
            parser.error("Для файла вне проекта укажите --mode.")
        destination = ROOT / "assets" / "maps" / selected_mode["id"] / ("map" + source_path.suffix.lower())
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        source_path = destination.resolve()
        selected_mode["image"] = relative_path(source_path)

    source_ref = relative_path(source_path)
    linked_modes = [mode for mode in modes if mode.get("image") == source_ref]
    if selected_mode is not None and selected_mode not in linked_modes:
        linked_modes.append(selected_mode)
    if not linked_modes:
        parser.error("Ни один режим не ссылается на этот файл. Укажите --mode или обновите image в config.json.")

    min_zoom = config.get("map", {}).get("minZoom", -4)
    level_count = max(1, math.ceil(max(0, -min_zoom)) + 1)
    output_path = source_path.parent / "tiles"
    print(f"Создание тайлов для {source_path.name} ({source_path.stat().st_size / (1024 * 1024):.1f} МБ)...", flush=True)
    try:
        source_width, source_height = make_tiles(source_path, output_path, level_count)
    except Exception as error:
        print(f"Ошибка нарезки: {error}", file=sys.stderr)
        return 1

    tile_set = {
        "path": relative_path(output_path),
        "tileSize": TILE_SIZE,
        "levels": level_count,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
    }
    for mode in linked_modes:
        mode["tiles"] = tile_set

    temp_config = CONFIG_PATH.with_suffix(".json.tmp")
    temp_config.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_config.replace(CONFIG_PATH)
    print(f"Готово: создано {level_count} уровней, тайлы подключены к режимам: {', '.join(mode['id'] for mode in linked_modes)}.")
    print("Обновите страницу атласа.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
