// A student's upload is called "Student upload <id>" in every export: its title comes from the file name the student
// chose, which can hold a name. The teacher's lessons keep their titles. `l` is the lessons table in the query.
export const EXPORT_TITLE = "CASE WHEN l.origin = 'student' THEN 'Student upload ' || l.id ELSE l.title END";
