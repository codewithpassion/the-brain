/**
 * Editor image upload glue (G1). Client-only — imported only by the lazy `Editor` chunk, so nothing
 * here enters the SSR bundle. `ImageUpload` is a tiny extension whose storage holds the file-picker
 * opener (set by `Editor`, called by the slash-menu "Image" command). `uploadAndInsertImage` reads a
 * File → base64, uploads via the `wiki_upload_image` op (the `wikiUploadImage` server fn), then inserts
 * the returned `/wiki-media/<id>` src — which `@tiptap/extension-image` round-trips to `![alt](src)`.
 */
import { type Editor, Extension } from "@tiptap/core"
import { wikiUploadImage } from "../../server/fns"
import { toast } from "../Toaster"

/** The image types the wiki accepts (mirror of the op's whitelist). */
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export const isSupportedImage = (file: File): boolean => IMAGE_MIME.has(file.type)

export interface ImageUploadStorage {
  /** Opens the hidden file input; `Editor` wires this in `onCreate`. */
  open: (() => void) | null
}

/** Holds the file-picker opener so the static slash-menu command can trigger it via editor storage. */
export const ImageUpload = Extension.create({
  name: "imageUpload",
  addStorage(): ImageUploadStorage {
    return { open: null }
  },
})

/** Read a File as raw base64 (strip the `data:...;base64,` prefix the op tolerates anyway). */
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("failed to read image file"))
    reader.readAsDataURL(file)
  })

/**
 * Upload one image file and insert it at the current selection. Surfaces progress + failures as toasts;
 * an unsupported type is rejected before any upload. Never throws — a failed upload just toasts.
 */
export const uploadAndInsertImage = async (editor: Editor, file: File): Promise<void> => {
  if (!isSupportedImage(file)) {
    toast(`Unsupported image type: ${file.type || "unknown"}`)
    return
  }
  toast(`Uploading ${file.name}…`)
  try {
    const base64 = await fileToBase64(file)
    const res = await wikiUploadImage({
      data: { filename: file.name, data: base64, contentType: file.type },
    })
    if (!res.ok) {
      toast(`Image upload failed: ${res.error}`)
      return
    }
    editor
      .chain()
      .focus()
      .setImage({ src: `/wiki-media/${res.data.id}`, alt: file.name })
      .run()
  } catch (error) {
    toast(`Image upload failed: ${error instanceof Error ? error.message : "error"}`)
  }
}
