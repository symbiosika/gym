/**
 * The value of a "none" option in a Select.
 *
 * PrimeVue reads an empty string as "nothing is selected": it hides the label
 * and the field looks empty, even though an option stands for it. So the
 * options that mean "no policy", "no collection", "all" or "the automatic
 * spec" carry this value and the component maps it to `null` or `''` at its
 * edge, where the API expects it.
 */
export const NONE = '__none__'
