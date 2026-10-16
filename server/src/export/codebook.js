// README.txt inside the export zip: what each file and column means.

export const CODEBOOK = ({ now, includeP00, lessons }) => `StudyRevr research export
Made ${now.toISOString()} (UTC). ${includeP00 ? 'Includes P00 (researcher test data).' : 'P00 (researcher test data) is left out.'}

General
- Participants appear by code only (P01, P02, ...). No names, settings or API keys (the researcher's or students')
  are exported.
- Timestamps (*_at) are UTC, ISO 8601. study_date is the study day in Asia/Manila; a study day starts at 04:00,
  so 01:30 on Tuesday belongs to Monday. Flashcard scheduling uses the same boundary.
- Times: *_ms are milliseconds, *_min minutes. Percentages are 0-100.
- Active time counts only time with the app in front and the student interacting: it pauses when the app goes to
  the background and a session ends after 5 minutes without a tap, scroll or key press (those 5 minutes are not
  counted).
- time_ms (flashcard_reviews.csv, quiz_answers.csv) is the time the student spent on one card or question, from
  when it is on screen and can be answered to the answer. It leaves out:
    - animations: the deck coming out, a quiz sheet being handed out, a card turning over, the marks drawn after an
      answer. Turning the screen's motion setting on or off does not change it.
    - time away: it pauses while the app is hidden (a locked phone, another app or tab) and carries on when the
      student comes back.
  It is capped at 1 hour. A flashcard cannot be rated until it has finished turning, so the turn is never in time_ms.
  Reloading or reopening the app starts the open card's or question's time again from 0, so a row can be shorter than
  the real time on that card.
  Rows answered before the study copy was updated to this version (the researcher notes that day) also counted the
  animations of that time, about 0.2-0.6 s per flashcard (its slide-in and the flip) and about 0.2-0.4 s per quiz
  question (the fade between questions), and did not pause when the app was hidden. Split by reviewed_at / answered_at
  at that day to compare. A quiz's duration_ms likewise starts when its first question can be answered (before, it
  included that question's 0.2 s fade-in), and there is no longer a fade between questions in it.

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
  true/false questions are shown to students as a Yes/No question ("Does this describe [term]?" for a term card, "Is
  this the right answer to [question]?" for a concept card, with the statement under it), but they are stored and
  exported as true/false: choices, chosen_answer and right_answer say True or False (Yes = True, No = False).
  question, statement  as the student saw them. For a term card, the definition in question (multiple choice) or
                    statement (true/false) is stored masked: where a definition names its term (or a form of it),
                    the term is written as ___, so the definition doesn't give the term away. The flashcard itself
                    is unchanged.
  chosen_answer, right_answer, correct (1/0; blank if not answered), time_ms on the question

events.csv - self-monitoring events
  type  stats_view | quiz_retake | review_flashcards_tap | section_simplify | section_translate
  section_index  0-based section number, for section_simplify and section_translate
  (every tap that opens a rewrite is an event, whether or not the AI was asked; see ai_calls.csv for the AI requests)

setting_events.csv - settings a participant changed, one row per change
  setting  motion (the Motion choice in Settings)
  value    system (Match my device) | less (Less motion) | full (Full motion)
  It only changes how much the screens animate. It never changes time_ms: answer time leaves animation out with
  every choice.

ai_calls.csv - one row per live AI request for Explain simpler (kind simplify) or Filipino/Taglish (kind translate):
  the rewrite was not already saved for everyone, or the student uses their own key. Rewrites saved ahead of time by
  the researcher ("Prepare") and taps served from that saved version are not AI requests and are not listed.
  outcome              ok | failed (nothing answered; error_code says why)
  ai_source            who answered: student (the student's own key) | default (the app's AI, set by the
                       researcher) | gemma (the backup model, used when the default was busy or down); blank if failed
  ai_provider, ai_model  the provider and model that answered (if failed: the last one tried)
  ai_fallback_steps    how many times the request moved on to the next step: 0 = the first choice answered (or, if
                       nothing answered, it failed and no other step was tried). Otherwise the steps that failed before
                       the answer or, if nothing answered, the steps tried after the first. The order is the student's
                       key (only if they saved one), then default, then gemma. A gemma retry after an instant provider
                       error is not a step: it is listed in ai_fallback_reasons (gemma:provider_error) even when the
                       retry answered.
  ai_fallback_reasons  each failed step as source:reason, e.g. student:auth;default:rate_limit. Every reason that can
                       appear:
                         rate_limit      the provider's limit (429) or the app's own request limit
                         timeout         no answer in time
                         network         the provider could not be reached
                         provider_error  the provider's 5xx
                         auth            the key was rejected (401/403)
                         no_credit       no credit or quota left (402)
                         not_found       the provider does not know the model or address (404)
                         bad_request     the provider rejected the request (400)
                         invalid_json    the model's reply was not usable JSON, twice
                         bad_response    the provider's reply had no answer in it
                         not_configured  no key or model set for that step
                         error           anything unexpected
                       A step falls back to the next only for some of these: student: all except not_configured and
                       error; default: rate_limit, timeout, network, provider_error, not_found, bad_request,
                       invalid_json, bad_response; gemma is last. Other reasons end the request (outcome failed).
  from_cache           1 if the answer was the default version already saved (the student's own key had failed, or it
                       was saved a moment earlier by Prepare or by another student's tap)
  saved_shared         1 if this answer was saved as the version everyone sees (default answers only; answers
                       from a student's key or from gemma are shown to that student only)
  error_code           when failed: the last step's reason, one of the list above (the student saw "The AI is busy,
                       try again in a minute." for rate_limit and "The AI couldn’t answer right now. Try again in a
                       minute." for every other reason)
  ms                   time the whole request took, all steps included
`;
