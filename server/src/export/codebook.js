// README.txt inside the export zip: what each file and column means.

export const CODEBOOK = ({ now, includeP00, lessons }) => `StudyRevr research export
Made ${now.toISOString()} (UTC). ${includeP00 ? 'Includes P00 (researcher test data).' : 'P00 (researcher test data) is left out.'}

General
- Participants appear by code only (P01, P02, ...). No names, settings or API keys are exported.
- Timestamps (*_at) are UTC, ISO 8601. study_date is the study day in Asia/Manila; a study day starts at 04:00,
  so 01:30 on Tuesday belongs to Monday. Flashcard scheduling uses the same boundary.
- Times: *_ms are milliseconds, *_min minutes. Percentages are 0-100.
- Active time counts only time with the app in front and the student interacting: it pauses when the app goes to
  the background and a session ends after 5 minutes without a tap, scroll or key press (those 5 minutes are not
  counted).

summary.csv - one row per participant; columns grouped by SDL dimension
  Planning (study planning and time management)
    planning_days_active            study days with active session time, a flashcard answer or a quiz answer
    planning_total_sessions         sessions with any active time
    planning_reading_min / _flashcards_min / _quiz_min / _total_min   active minutes per activity (reading = Review tab)
    planning_first_study_date, planning_last_study_date               first and last of those study days
    planning_reviews_on_time        due flashcard reviews done on their due day (see due_reviews.csv)
    planning_reviews_late           due reviews done on a later day
    planning_reviews_still_overdue  due reviews not done yet whose due day is over
    planning_avg_days_late          mean days late over late reviews only (blank if none)
    planning_on_time_rate           on_time / (on_time + late + still_overdue), 0-1; blank if nothing was due.
                                    The three counts are separate columns so the rate can be recalculated.
  Retention (memory retention and concept mastery)
    retention_cards_reviewed        flashcard answers given (undone answers are not counted)
    retention_good_easy_pct         % of those answered Good or Easy
    retention_quiz_first_pct_mean   mean of the per-lesson first-attempt scores below
    retention_quiz_first_pct_L<id>  score (%) of the first finished quiz on lesson <id>; blank if none finished.
${lessons.map((l) => `                                    L${l.id} = ${l.title}`).join('\n') || '                                    (no lessons)'}
  Self-monitoring (self-monitoring and evaluation)
    self_monitoring_stats_views             times the Stats tab was opened
    self_monitoring_quiz_retakes            quiz retakes started
    self_monitoring_review_flashcards_taps  taps on "Review these flashcards" after a quiz
    self_monitoring_simplify_taps           taps on a section's "Explain simpler"
    self_monitoring_translate_taps          taps on a section's "Filipino/Taglish"

sessions.csv - one row per study session
  activity      reading (Review tab) | flashcards | quiz;  lesson_id blank = the "All lessons" flashcard deck
  end_reason    left (closed the screen) | idle (5 min without interaction) | background (away more than 5 min) |
                switched (switched participant) | unclosed (the app stopped reporting, e.g. the browser was closed;
                ended_at is its last report) | open (still running)
  active_ms / active_min   active time (see General)

flashcard_reviews.csv - one row per flashcard answer
  rating 1-4 (again, hard, good, easy); good_or_easy 1 when rating is 3 or 4
  state_before  the card's state for this participant before the answer: new | learning | review | relearning
  prev_interval_days / new_interval_days   interval before and after (a learning step is a fraction of a day)
  due_date, due_status, days_late   for review-state cards only: the day it was due, on_time | late, and days late;
                                    n/a for new and learning cards (their steps are minutes apart)

due_reviews.csv - the planning metric: one row per time a review-state card came due
  status  on_time (done on its due day) | late (done days_late days after) | still_overdue (not done; days_late =
          days overdue so far). A card due today and not done yet is not listed.

quiz_attempts.csv - one row per quiz attempt, including ones left part-way
  status            finished | abandoned (left part-way; more than 2 hours old, so it can no longer be resumed) |
                    open (left part-way less than 2 hours ago; can still be resumed)
  is_retake, retake_of   1 and the attempt whose questions were reused, for a retake
  is_first_attempt  1 for the participant's first finished attempt on that lesson
  answered          questions answered; score and percent are blank unless finished

quiz_answers.csv - one row per question of each attempt above
  type mc (multiple choice) | tf (true/false); kind term | concept (the flashcard it came from)
  chosen_answer, right_answer, correct (1/0; blank if not answered), time_ms on the question

events.csv - self-monitoring events
  type  stats_view | quiz_retake | review_flashcards_tap | section_simplify | section_translate
  section_index  0-based section number, for section_simplify and section_translate
`;
