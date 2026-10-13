/**
 * Messages of the API in the words of the operator. The backend answers in
 * English and names the rule that was broken; the banner says the same in
 * the UI language and, where it helps, what to do. A message this table does
 * not know is shown as it came, never swallowed.
 */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** exact messages of the API, by locale key under `errors.` */
const EXACT: Record<string, string> = {
  'The block has no plan': 'noPlan',
  'Create a plan before recording': 'noPlan',
  'Create a plan before working on its images': 'noPlan',
  'The block is closed': 'blockClosed',
  'Set the target number of episodes first': 'needsTarget',
  'Describe the task before starting without a plan': 'needsTask',
  'No episodes selected': 'noEpisodes',
  'Upload a dataset and wait for the critics first': 'waitForCritics',
  'Findings can be downgraded once the critics run is done': 'waitForCritics',
  'The kind of a block can only change while it has neither a plan nor a dataset': 'kindLocked',
  'The block has no scene photo': 'noScenePhoto',
  'The block needs a scene photo before images can be generated': 'noScenePhoto',
  'No image model is configured on this instance': 'noImageModel',
  'The image is larger than 15 MB': 'imageTooLarge',
  'Only JPEG, PNG, WebP or HEIC images are accepted': 'imageType',
  'Upload the LeRobot dataset as one zip archive (data, videos and meta)': 'zipOnly',
  'The upload is empty': 'uploadEmpty',
  'The source skill has no block of this kind to import from': 'importNothing',
  'An evaluation has no episode selection': 'evaluationNoSelection',
  'The cell has day protocols; deactivate it instead of deleting it': 'cellInUse',
}

/** messages with a variable part */
const PATTERNS: [RegExp, string][] = [
  [/^The upload (lost chunk|is incomplete)/, 'uploadBroken'],
  [/^The assembled dataset is \d+ bytes/, 'uploadBroken'],
  [/^Chunk \d+ /, 'uploadBroken'],
  [/^The dataset is larger than/, 'datasetTooLarge'],
  [/^Cell ".*" is inactive$/, 'cellInactive'],
  [/^A (cell|collection) named ".*" already exists$/, 'nameTaken'],
  [/^(Failed to fetch|NetworkError|Load failed)/i, 'network'],
]

export function readableError(text: string, t: Translate): string {
  const message = text.trim()
  const exact = EXACT[message]
  if (exact) return t(`errors.${exact}`)
  for (const [re, key] of PATTERNS) if (re.test(message)) return t(`errors.${key}`)
  if (/ not found$/.test(message)) return t('errors.notFound')
  return message
}
