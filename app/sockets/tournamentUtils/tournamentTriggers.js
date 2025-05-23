const createLogger = require('../../logger');
const logger = createLogger('TournamentTriggers');
const { tournamentState } = require('./tournamentState');
// Import helpers at the top level now
const { sendQuestionWithState, handleTimerExpiration, calculateScore, saveParticipantScore } = require('./tournamentHelpers');
const { updateQuestionTimer } = require('../quizUtils');
const { quizState } = require('../quizState');

// --- Trigger Functions (Exported) ---

// Sends the question data and sets initial state, but DOES NOT start the timer itself.
// Timer is started via triggerTournamentTimerSet.
function triggerTournamentQuestion(io, code, index, linkedQuizId = null, initialTime = null, targetQuestionUid = null) {
    const state = tournamentState[code];
    if (!state || !state.questions) {
        logger.error(`[TriggerQuestion] Invalid state or missing questions for code ${code}`);
        return;
    }

    // CRITICAL FIX: If a specific targetQuestionUid is provided, find it in the questions array
    // This ensures we activate exactly the question requested by UID regardless of array ordering
    let targetIndex = index;
    let targetQuestion = null;

    if (targetQuestionUid) {
        // Find the question by UID (overrides the index parameter)
        const foundIndex = state.questions.findIndex(q => q.uid === targetQuestionUid);
        if (foundIndex !== -1) {
            targetIndex = foundIndex;
            targetQuestion = state.questions[foundIndex];
            logger.info(`[TriggerQuestion] Found requested question ${targetQuestionUid} at index ${targetIndex}`);
        } else {
            logger.error(`[TriggerQuestion] Requested question ${targetQuestionUid} not found in tournament ${code}`);
            return; // Don't proceed with an invalid question
        }
    } else if (index >= state.questions.length) {
        logger.error(`[TriggerQuestion] Invalid index ${index} for code ${code}, questions length ${state.questions.length}`);
        return;
    }

    state.linkedQuizId = linkedQuizId; // Ensure linkedQuizId is set

    // Store both the index and the actual UID for consistency
    const questionUid = targetQuestion ? targetQuestion.uid : state.questions[targetIndex]?.uid;
    state.currentQuestionUid = questionUid; // Store the UID explicitly

    logger.info(`[TriggerQuestion] Called: code=${code}, index=${targetIndex}, questionUid=${questionUid}, linkedQuizId=${linkedQuizId || 'none'}, initialTime=${initialTime}`);

    // Call sendQuestionWithState to emit the question and set base state
    // Using async-await could cause timing issues, make direct call instead
    try {
        // The question we want to use is either targetQuestion or the question at targetIndex
        const question = targetQuestion || state.questions[targetIndex];
        if (!question) {
            logger.error(`[TriggerQuestion] Question not found at index ${targetIndex} for code ${code}`);
            return;
        }

        logger.info(`[TriggerQuestion] Emitting question ${question.uid} to live_${code}`);

        // Set tournament state properties directly
        state.currentQuestionUid = question.uid;
        const time = initialTime !== null ? initialTime : (question.temps || 20);
        state.currentQuestionDuration = time;

        // Direct emission to live_${code} room to ensure delivery
        const { sendTournamentQuestion } = require('./sendTournamentQuestion');
        sendTournamentQuestion(io, `live_${code}`, question, targetIndex, state.questions.length, time, "active", !!linkedQuizId);

        logger.info(`[TriggerQuestion] Successfully emitted tournament_question event for ${question.uid} to live_${code}`);
    } catch (err) {
        logger.error(`[TriggerQuestion] Error emitting question: ${err.message}`);
    }

    logger.debug(`[TriggerQuestion] Timer must be started separately via triggerTournamentTimerSet.`);
}

// Pauses the currently running timer.
function triggerTournamentPause(io, code, remainingTime = null) {
    const state = tournamentState[code];
    if (!state || state.isDiffered || state.paused || state.stopped) {
        logger.warn(`[TriggerPause] Ignoring pause for ${code}. State: isDiffered=${state?.isDiffered}, paused=${state?.paused}, stopped=${state?.stopped}`);
        return; // Ignore if differed, already paused, or stopped
    }

    // Ensure proper pausing of the timer - use multiple checks to be absolutely sure
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        logger.info(`[TriggerPause] Cleared active timer for ${code}`);
    }

    // Clear interval timer if it exists
    if (state.intervalTimer) {
        clearInterval(state.intervalTimer);
        state.intervalTimer = null;
        logger.info(`[TriggerPause] Cleared interval timer for ${code}`);
    }

    // Extra cleanup to ensure no stale timers fire
    if (state._timerRef) {
        try {
            clearTimeout(state._timerRef);
            logger.info(`[TriggerPause] Cleared additional timer reference for ${code}`);
        } catch (e) {
            logger.warn(`[TriggerPause] Error clearing additional timer: ${e.message}`);
        }
        state._timerRef = null;
    }

    // Priority 1: Use the provided remainingTime if it's valid
    let calculatedRemainingTime;

    if (remainingTime !== null && remainingTime > 0) {
        calculatedRemainingTime = remainingTime;
        logger.info(`[TriggerPause] Using provided remainingTime=${calculatedRemainingTime}s for ${code}`);
    } else {
        // Priority 2: Calculate based on elapsed time
        const elapsed = (Date.now() - state.questionStart) / 1000;
        calculatedRemainingTime = Math.max(0, state.currentQuestionDuration - elapsed);
        logger.debug(`[TriggerPause] Calculated remaining time: elapsed=${elapsed.toFixed(1)}s, originalDuration=${state.currentQuestionDuration}s, remaining=${calculatedRemainingTime.toFixed(1)}s`);
    }

    // Store both in state for redundancy with 1 decimal place precision
    state.pausedRemainingTime = parseFloat(calculatedRemainingTime.toFixed(1));
    state.pausedAt = Date.now(); // Store exactly when we paused
    state.paused = true;
    state.stopped = false; // Pausing overrides stopped

    logger.info(`[TriggerPause] Paused tournament ${code}. Remaining time: ${state.pausedRemainingTime}s`);

    // Use the precise value with 1 decimal place
    const preciseRemainingTime = state.pausedRemainingTime;

    // Explicitly notify tournament room
    io.to(`live_${code}`).emit("tournament_question_state_update", {
        questionState: "paused",
        remainingTime: preciseRemainingTime
    });

    // Ensure timeLeft is valid before emitting quiz_timer_update
    if (preciseRemainingTime <= 0) {
        logger.error(`[TriggerPause] Invalid timeLeft=${preciseRemainingTime} for pause. Skipping quiz_timer_update and quizState update.`);
        // Do not return entirely, as tournament itself is paused.
        // Only skip the quiz-related updates if timeLeft is invalid.
    } else if (state.linkedQuizId) {
        updateQuestionTimer(state.linkedQuizId, state.currentQuestionUid, 'pause', preciseRemainingTime);
        io.to(`dashboard_${state.linkedQuizId}`).emit("quiz_timer_update", {
            status: 'pause',
            questionId: state.currentQuestionUid,
            timeLeft: preciseRemainingTime,
            timestamp: Date.now()
        });
        logger.debug(`[TriggerPause] Updated quizState and emitted synchronized quiz_timer_update (pause) for questionUid=${state.currentQuestionUid}`);
    }
}

// Resumes a paused timer. Use triggerTournamentTimerSet(..., timeLeft, true) instead.
// This function is deprecated and will be removed after refactoring handlers.
function triggerTournamentResume(io, code) {
    logger.warn(`[DEPRECATED] triggerTournamentResume called for ${code}. Use triggerTournamentTimerSet(..., timeLeft, true) instead.`);
    const state = tournamentState[code];
    if (state && state.paused) {
        const timeLeft = state.pausedRemainingTime;
        triggerTournamentTimerSet(io, code, timeLeft, true); // Delegate to the main timer function
    }
}

// The primary function to control the timer: start, stop, edit duration.
// - timeLeft > 0: Starts or updates the timer. If forceActive=true, ensures it runs even if previously stopped/paused.
// - timeLeft = 0: Stops the timer and marks the state as stopped.
function triggerTournamentTimerSet(io, code, timeLeft, forceActive = false) {
    const state = tournamentState[code];
    if (!state || state.isDiffered) {
        logger.warn(`[TimerSet] Ignoring timer set for ${code}. State: exists=${!!state}, isDiffered=${state?.isDiffered}`);
        return; // Ignore if no state or differed mode
    }

    // Add more detailed debugging
    logger.debug(`[TimerSet] INITIAL STATE: code=${code}, timeLeft=${timeLeft}, forceActive=${forceActive}, paused=${state.paused}, stopped=${state.stopped}, pausedRemainingTime=${state.pausedRemainingTime}`);

    // Prevent duplicate stop actions
    if (timeLeft === 0 && state.stopped) {
        logger.info(`[TimerSet] Timer already stopped for ${code}. Skipping duplicate stop action.`);
        return;
    }

    logger.info(`[TimerSet] Setting timer: code=${code}, timeLeft=${timeLeft}s, forceActive=${forceActive}`);

    // Always clear all existing timers before proceeding
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        logger.debug(`[TimerSet] Cleared primary timer for ${code}`);
    }

    // Clear interval timer if it exists
    if (state.intervalTimer) {
        clearInterval(state.intervalTimer);
        state.intervalTimer = null;
        logger.debug(`[TimerSet] Cleared interval timer for ${code}`);
    }

    if (state._timerRef) {
        try {
            clearTimeout(state._timerRef);
            logger.debug(`[TimerSet] Cleared backup timer reference for ${code}`);
        } catch (e) {
            logger.warn(`[TimerSet] Error clearing backup timer: ${e.message}`);
        }
        state._timerRef = null;
    }

    // --- Handle Stop Condition (timeLeft === 0) ---
    if (timeLeft === 0) {
        state.stopped = true;
        state.paused = false; // Stop overrides pause
        state.currentQuestionDuration = 0;
        state.pausedRemainingTime = null;
        state.pausedAt = null;
        logger.info(`[TimerSet] Stopping timer for ${code}.`);

        io.to(`live_${code}`).emit("tournament_set_timer", {
            timeLeft: 0,
            questionState: "stopped" // Use specific state for stop
        });

        if (state.linkedQuizId) {
            let questionUid = state.currentQuestionUid;
            io.to(`dashboard_${state.linkedQuizId}`).emit("quiz_timer_update", {
                status: 'stop',
                questionId: questionUid,
                timeLeft: 0,
                timestamp: Date.now()
            });
            // Ensure quizState is updated
            updateQuestionTimer(state.linkedQuizId, questionUid, 'stop', 0);
            logger.info(`[TimerSet] Emitted quiz_timer_update (stop) and updated quizState to dashboard_${state.linkedQuizId} (questionId=${questionUid})`);
        }
        return; // Stop processing here
    }

    // --- Handle Start/Resume/Edit Condition (timeLeft > 0) ---

    // Add error handling to ensure the question is properly fetched
    if (!state.currentQuestionUid) {
        logger.error(`[TimerSet] currentQuestionUid is not set for code=${code}. Aborting timer setup.`);
        return;
    }

    const question = state.questions.find(q => q.uid === state.currentQuestionUid);
    if (!question) {
        logger.error(`[TimerSet] Question UID ${state.currentQuestionUid} not found in tournament state for code=${code}. Aborting timer setup.`);
        return;
    }

    // Step 1: Determine the correct timeLeft value to use
    let originalTimeLeft = timeLeft;

    // Fix for initial timeLeft value when starting new questions
    if (timeLeft === undefined || timeLeft === null) {
        if (state.paused && state.pausedRemainingTime !== null && state.pausedRemainingTime > 0) {
            timeLeft = state.pausedRemainingTime;
            logger.info(`[TimerSet] Using stored pausedRemainingTime: ${timeLeft}s`);
        } else {
            const question = state.questions.find(q => q.uid === state.currentQuestionUid);
            if (!question) {
                logger.error(`[TimerSet] Question UID ${state.currentQuestionUid} not found in tournament state.`);
                return;
            }
            timeLeft = question.temps || 20;
            logger.info(`[TimerSet] Fetched initial timer value from question: ${timeLeft}s for code=${code}`);
        }
    } else if (timeLeft <= 0 && forceActive) {
        // If timeLeft is invalid but we're forcing active, use a default or question time
        const question = state.questions.find(q => q.uid === state.currentQuestionUid);
        timeLeft = (question && question.temps) || 20;
        logger.info(`[TimerSet] Received invalid timeLeft=${timeLeft}, using question time or default: ${timeLeft}s`);
    }

    // Add detailed logging for TimerSet
    logger.debug(`[TimerSet] Initial timeLeft=${timeLeft}, question.temps=${question.temps}, pausedRemainingTime=${state.pausedRemainingTime}`);

    // Ensure timeLeft is initialized correctly
    if (!timeLeft && question.temps) {
        timeLeft = question.temps;
        logger.info(`[TimerSet] Using question.temps=${timeLeft} as initial timeLeft for code=${code}`);
    }

    logger.debug(`[TimerSet] After fetch: timeLeft=${timeLeft}s (originally ${originalTimeLeft}), question.temps=${state.questions?.[state.currentIndex]?.temps}, pausedRemainingTime=${state.pausedRemainingTime}`);

    // Prioritize pausedRemainingTime when resuming the timer
    if (forceActive && state.paused && state.pausedRemainingTime !== null && state.pausedRemainingTime > 0) {
        if (typeof timeLeft === 'number' && timeLeft > state.pausedRemainingTime) {
            logger.warn(`[TimerSet] Client attempted to resume with timeLeft=${timeLeft} > pausedRemainingTime=${state.pausedRemainingTime}. Forcing use of pausedRemainingTime.`);
        }
        logger.info(`[TimerSet] Resuming from paused state with precise pausedRemainingTime=${state.pausedRemainingTime}s (ignoring any passed timeLeft)`);
        timeLeft = state.pausedRemainingTime;

        if (state.pausedAt) {
            const pauseDuration = (Date.now() - state.pausedAt) / 1000;
            logger.debug(`[TimerSet] Timer was paused for ${pauseDuration.toFixed(1)} seconds`);
        }

        // Reset pause state
        state.paused = false;
        state.questionStart = Date.now();
        state.pausedAt = null;
    }

    if (!forceActive) {
        if (state.stopped) {
            state.currentQuestionDuration = timeLeft;
            logger.info(`[TimerSet] Updating duration to ${timeLeft}s for stopped tournament ${code}. It remains stopped.`);
            io.to(`live_${code}`).emit("tournament_set_timer", {
                timeLeft: timeLeft,
                questionState: "stopped"
            });
            return;
        }
        if (state.paused) {
            state.pausedRemainingTime = timeLeft;
            state.currentQuestionDuration = timeLeft;
            logger.info(`[TimerSet] Updating remaining time to ${timeLeft}s for paused tournament ${code}. It remains paused.`);
            io.to(`live_${code}`).emit("tournament_set_timer", {
                timeLeft: timeLeft,
                questionState: "paused"
            });

            if (state.linkedQuizId) {
                let questionUid = state.currentQuestionUid;
                updateQuestionTimer(state.linkedQuizId, questionUid, 'pause', timeLeft);
                io.to(`dashboard_${state.linkedQuizId}`).emit("quiz_timer_update", {
                    status: 'pause',
                    questionId: questionUid,
                    timeLeft: timeLeft,
                    timestamp: Date.now()
                });
                logger.info(`[TimerSet] Updated quizState and emitted quiz_timer_update (pause) for dashboard_${state.linkedQuizId} with timeLeft=${timeLeft}`);
            }
            return;
        }

        state.questionStart = Date.now();
        logger.info(`[TimerSet] Editing running timer for ${code} to ${timeLeft}s. Resetting questionStart.`);
    } else {
        // Set forceActive state changes that weren't handled in the earlier block
        state.stopped = false;
        state.paused = false;
        state.questionStart = Date.now();
        // Don't clear pausedRemainingTime immediately - we might need it for another resume
        logger.debug(`[TimerSet] After forceActive handling: timeLeft=${timeLeft}s, wasPaused=false`);
    }

    if (timeLeft <= 0) {
        logger.error(`[TimerSet] Invalid timeLeft value (${timeLeft}) for code=${code}. Aborting timer setup.`);
        return;
    }

    state.currentQuestionDuration = timeLeft;
    state.paused = false;
    state.stopped = false;

    logger.info(`[TimerSet] Starting timer for ${code} with duration ${timeLeft}s.`);

    io.to(`live_${code}`).emit("tournament_set_timer", {
        timeLeft: timeLeft,
        questionState: "active"
    });

    // --- PATCH: Detect if this is a tournament mode (not regular quiz mode) ---
    // You may need to adjust this logic based on your app's state structure
    const isTournamentMode = state.statut === 'en cours' || code.startsWith('T') || !!state.isTournamentMode;
    state.isTournamentMode = isTournamentMode;

    // FIX: Only update quiz timer from tournament if this is a real tournament, not a quiz-linked tournament
    // In quiz-linked tournaments, the teacher dashboard is the only source of truth for the quiz timer
    if (state.linkedQuizId && timeLeft > 0) { // Removed isTournamentMode check here as it's redundant if linkedQuizId exists
        // If it's a quiz-linked tournament, DO NOT call updateQuestionTimer for the quiz from here.
        // The quiz timer is controlled by the teacher's dashboard via quiz socket events.
        // We still emit quiz_timer_update to inform the dashboard about the tournament's timer.

        // Correction: The server-side quizState MUST be updated to reflect the timer's true state.
        const quizTimerStatus = forceActive ? 'play' : (state.timerStatus || 'play');
        updateQuestionTimer(state.linkedQuizId, state.currentQuestionUid, quizTimerStatus, timeLeft);

        io.to(`dashboard_${state.linkedQuizId}`).emit("quiz_timer_update", {
            status: quizTimerStatus, // Ensure timerStatus has a fallback
            questionId: state.currentQuestionUid,
            timeLeft: timeLeft,
            timestamp: Date.now()
        });
        logger.info(`[TimerSet] Emitted quiz_timer_update and updated quizState for dashboard_${state.linkedQuizId} with timeLeft=${timeLeft}`);
    }

    // Emit tournament_question along with tournament_set_timer if currentQuestionUid has changed
    if (!state.previousQuestionUid || state.previousQuestionUid !== state.currentQuestionUid) {
        const question = state.questions.find(q => q.uid === state.currentQuestionUid);
        if (question) {
            const { sendTournamentQuestion } = require('./sendTournamentQuestion');
            sendTournamentQuestion(io, `live_${code}`, question, state.questions.indexOf(question), state.questions.length, timeLeft, "active", !!state.linkedQuizId);
            logger.info(`[TimerSet] Emitted tournament_question for questionUid=${state.currentQuestionUid}`);
        } else {
            logger.warn(`[TimerSet] Unable to emit tournament_question: Question UID ${state.currentQuestionUid} not found.`);
        }
    }

    // Update previousQuestionUid to track changes
    state.previousQuestionUid = state.currentQuestionUid;

    // Store current time as the start time
    state.questionStart = Date.now();
    const initialTimeLeft = timeLeft;

    // Set up an interval to emit timer updates every second
    let remainingTime = timeLeft;
    state.intervalTimer = setInterval(() => {
        if (state.paused || state.stopped) {
            clearInterval(state.intervalTimer);
            state.intervalTimer = null;
            logger.debug(`[TimerInterval] Clearing interval timer due to paused=${state.paused} or stopped=${state.stopped}`);
            return;
        }

        remainingTime -= 1;

        // --- PATCH: Do NOT emit quiz_timer_update on every tick ---
        // Only emit tournament_set_timer for tournament clients
        io.to(`live_${code}`).emit("tournament_set_timer", {
            timeLeft: Math.max(0, remainingTime),
            questionState: "active"
        });

        // If timer reaches zero, clear the interval and handle expiration
        if (remainingTime <= 0) {
            clearInterval(state.intervalTimer);
            state.intervalTimer = null;
            logger.info(`[TimerInterval] Timer expired for ${code}`);
            handleTimerExpiration(io, code);
        }
    }, 1000);

    // Still keep the main timer as a backup mechanism
    state.timer = setTimeout(() => {
        if (state.paused || state.stopped) {
            logger.warn(`[TimerSet] Timer fired for ${code} but state is paused=${state.paused} or stopped=${state.stopped}. Ignoring expiration.`);
            return;
        }
        logger.info(`[TimerSet] setTimeout fired for code=${code}`);

        // Clear the interval if it's still running
        if (state.intervalTimer) {
            clearInterval(state.intervalTimer);
            state.intervalTimer = null;
            logger.debug(`[TimerSet] Cleared interval timer on timer expiration for ${code}`);
        }

        handleTimerExpiration(io, code);
    }, timeLeft * 1000);

    state._timerRef = state.timer;
}

// Centralized function to manage timer actions
function manageTimer(io, code, action, timeLeft, forceActive = false) {
    const state = tournamentState[code];
    if (!state) {
        logger.warn(`[manageTimer] Tournament state not found for code=${code}`);
        return;
    }

    switch (action) {
        case 'play':
            triggerTournamentTimerSet(io, code, timeLeft, forceActive);
            break;
        case 'pause':
            triggerTournamentPause(io, code, timeLeft);
            break;
        case 'stop':
            triggerTournamentTimerSet(io, code, 0);
            break;
        default:
            logger.warn(`[manageTimer] Unknown action=${action} for code=${code}`);
    }
}

// --- Force end of tournament, save scores, update leaderboard, emit redirect ---
// (forceTournamentEnd function remains largely the same, ensure logging uses new style)
async function forceTournamentEnd(io, code) {
    const state = tournamentState[code];
    if (!state) {
        logger.warn(`[ForceEnd] Ignoring force end for non-existent tournament ${code}`);
        return;
    }
    // Clear any running timer
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }

    const prisma = require('../../db');
    logger.info(`[ForceEnd] Forcing end of tournament ${code}`);

    const leaderboard = Object.values(state.participants || {})
        .map(p => ({ id: p.id, pseudo: p.pseudo, avatar: p.avatar, score: p.score, isDiffered: !!p.isDiffered }))
        .sort((a, b) => b.score - a.score);
    logger.info(`[ForceEnd] Computed leaderboard for ${code}:`, leaderboard.length, 'participants');

    // Apply scaling logic using computeLeaderboard
    const { computeLeaderboard } = require('./computeLeaderboard');

    // BUGFIX: Sync askedQuestions from quizState to tournamentState if needed
    if (state.linkedQuizId && quizState[state.linkedQuizId] && quizState[state.linkedQuizId].askedQuestions) {
        logger.info(`[ForceEnd] Syncing askedQuestions from quizState[${state.linkedQuizId}] to tournamentState[${code}]`);
        if (!state.askedQuestions) {
            state.askedQuestions = new Set();
        }

        // Copy all asked questions from quiz state to tournament state
        quizState[state.linkedQuizId].askedQuestions.forEach(quid => {
            state.askedQuestions.add(quid);
        });

        logger.info(`[ForceEnd] After sync: askedQuestions has ${state.askedQuestions.size} items: ${Array.from(state.askedQuestions).join(', ')}`);
    }

    const askedQuestions = state.askedQuestions || new Set();
    const totalQuestions = state.questions.length;
    const scaledLeaderboard = computeLeaderboard(state, askedQuestions, totalQuestions);

    // Update participants' scores with scaled values
    scaledLeaderboard.forEach(entry => {
        const participant = state.participants[entry.id];
        if (participant) {
            participant.score = entry.score;
        }
    });

    logger.info(`[ForceEnd] Applied scaling logic. Updated leaderboard for ${code}:`, scaledLeaderboard);

    // Log the scaled leaderboard before saving to the database
    logger.info(`[ForceEnd] Preparing to save scaled leaderboard for tournament ${code}:`, scaledLeaderboard);

    // Ensure only the scaled leaderboard is saved
    await prisma.tournoi.update({
        where: { code },
        data: {
            date_fin: new Date(),
            statut: 'terminé',
            leaderboard: scaledLeaderboard // Save scaled leaderboard
        }
    });

    // Emit the final leaderboard after saving to the database
    io.to(`live_${code}`).emit("tournament_end", { leaderboard: scaledLeaderboard });
    logger.info(`[ForceEnd] Emitted scaled leaderboard to live_${code}`);

    try {
        const tournoi = await prisma.tournoi.findUnique({ where: { code } });
        logger.info(`[ForceEnd] Prisma tournoi found: ${tournoi ? tournoi.id : 'not found'}`);
        if (tournoi) {
            for (const participant of Object.values(state.participants || {})) {
                if (!participant.isDiffered && participant.id && !participant.id.startsWith('socket_')) {
                    await saveParticipantScore(prisma, tournoi.id, participant);
                }
            }
        }
    } catch (err) {
        logger.error(`[ForceEnd] Error saving scores/updating tournament ${code}:`, err);
    }

    logger.info(`[ForceEnd] Emitting tournament_finished_redirect to live_${code}`);
    io.to(`live_${code}`).emit("tournament_finished_redirect", { code });
    delete tournamentState[code];
    logger.info(`[ForceEnd] Deleted tournament state for ${code}`);
}


module.exports = {
    triggerTournamentQuestion,
    triggerTournamentPause,
    // triggerTournamentResume, // Deprecated
    triggerTournamentTimerSet,
    forceTournamentEnd,
    manageTimer,
};
