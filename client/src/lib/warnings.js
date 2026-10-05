// Upload warnings ("very little text was found") live only in memory: the server returns them once, with the upload.
const warnings = new Map();

export const setWarning = (lessonId, message) => warnings.set(lessonId, message);
export const getWarning = (lessonId) => warnings.get(lessonId) ?? null;
export const clearWarning = (lessonId) => warnings.delete(lessonId);
