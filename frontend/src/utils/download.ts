/** Trigger a browser download of a blob. */
export function downloadBlob(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

/** File name from a Content-Disposition header, or the fallback. */
export function fileNameFrom(header: string | null, fallback: string): string {
  const m = /filename="?([^";]+)"?/.exec(header ?? '')
  return m?.[1] ?? fallback
}
