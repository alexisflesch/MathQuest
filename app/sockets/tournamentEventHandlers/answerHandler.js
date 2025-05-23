const createLogger = require('../../logger');
const logger = createLogger('AnswerTournamentHandler');
const { tournamentState } = require('../tournamentUtils/tournamentState');

function handleTournamentAnswer(io, socket, { code, questionUid, answerIdx, clientTimestamp }) {
    logger.info(`tournament_answer received`);
    // Determine the correct state (live or differed)
    let joueurId = null;
    let stateKey = null;
    let state = null;

    // Check live state first
    if (tournamentState[code] && tournamentState[code].socketToJoueur && tournamentState[code].socketToJoueur[socket.id]) {
        stateKey = code;
        state = tournamentState[stateKey];
        joueurId = state.socketToJoueur[socket.id];
    } else {
        // Check differed states
        for (const key in tournamentState) {
            if (key.startsWith(`${code}_`) && tournamentState[key].socketToJoueur && tournamentState[key].socketToJoueur[socket.id]) {
                stateKey = key;
                state = tournamentState[key];
                joueurId = state.socketToJoueur[socket.id];
                break;
            }
        }
    }

    if (!state || !joueurId) {
        logger.warn(`tournament_answer: State or joueurId not found for socket ${socket.id} and code ${code}. Ignoring.`);
        return;
    }

    // Replace currentIndex with currentQuestionUid for fetching the active question
    const question = state.questions.find(q => q.uid === state.currentQuestionUid);
    if (!question) {
        logger.error(`[AnswerHandler] Question UID ${state.currentQuestionUid} not found in tournament state.`);
        return;
    }

    // Update all references to question properties
    const qIdx = state.questions.indexOf(question);

    if (qIdx < 0 || !state.questions || qIdx >= state.questions.length) {
        logger.warn(`tournament_answer: Invalid question index (${qIdx}) or missing questions for state ${stateKey}. Ignoring.`);
        return;
    }

    // Check if the answer is for the *current* question
    if (question.uid !== questionUid) {
        logger.warn(`tournament_answer: Answer received for wrong question (expected ${question.uid}, got ${questionUid}) for state ${stateKey}. Ignoring.`);
        return;
    }

    // *** Use currentQuestionDuration from state if available ***
    const timeAllowed = state.currentQuestionDuration || question.temps || 20;
    const questionStart = state.questionStart;

    if (!questionStart) {
        logger.warn(`tournament_answer: questionStart missing for state ${stateKey}. Ignoring.`);
        return; // Question hasn't properly started
    }

    // Enhanced logging about quiz/tournament state
    const serverReceiveTime = Date.now();
    const isDiffered = state.isDiffered; // Check state property
    const isPaused = state.paused;
    const isStopped = state.stopped;
    const isQuizMode = !!state.linkedQuizId;
    const elapsed = (serverReceiveTime - questionStart) / 1000;
    const remaining = timeAllowed - elapsed;

    logger.debug(`tournament_answer: Received answer for questionUid=${questionUid}, answerIdx=${answerIdx}, clientTimestamp=${clientTimestamp}`);

    // First check if the question is stopped - reject answers if it is
    if (state.stopped) {
        logger.warn(`tournament_answer: Answer rejected because question is stopped for state ${stateKey}`);
        socket.emit("tournament_answer_result", {
            rejected: true,
            reason: "stopped",
            message: "Trop tard !"
        });
        return;
    }

    // Always accept answers when the question is paused, regardless of time elapsed
    if (!state.paused) {
        // Only check timing if the question is NOT paused
        // Check timing using server receive time with grace period
        // *** Use the potentially updated timeAllowed ***
        if ((serverReceiveTime - questionStart) > timeAllowed * 1000 + 500) { // Add 500ms grace period
            logger.warn(`tournament_answer: Answer too late (server time, ${timeAllowed}s allowed) for state ${stateKey}. Ignoring.`);
            // Send rejection response back to client
            socket.emit("tournament_answer_result", {
                correct: false,
                rejected: true,
                reason: "late",
                message: "Trop tard !"
            });
            return;
        }

        // Also check client timestamp relative to question start
        // *** Use the potentially updated timeAllowed ***
        if ((clientTimestamp - questionStart) > timeAllowed * 1000) {
            logger.warn(`tournament_answer: Answer too late (client time, ${timeAllowed}s allowed) for state ${stateKey}. Ignoring.`);
            // Send rejection response back to client
            socket.emit("tournament_answer_result", {
                correct: false,
                rejected: true,
                reason: "late",
                message: "Trop tard !"
            });
            return;
        }
    } else {
        logger.info(`tournament_answer: Accepting answer during pause for state ${stateKey}.`);
    }

    // Store the answer (overwrite previous answer for the same question if any)
    // Defensive: check state.answers and state.answers[joueurId] before accessing
    const alreadyAnswered = !!(state.answers && state.answers[joueurId] && state.answers[joueurId][questionUid]);
    if (!state.answers) {
        logger.warn(`tournament_answer: Initializing state.answers for stateKey=${stateKey}`);
        state.answers = {};
    }
    if (!state.answers[joueurId]) {
        logger.warn(`tournament_answer: Initializing state.answers[${joueurId}] for stateKey=${stateKey}`);
        state.answers[joueurId] = {};
    }
    logger.debug(`tournament_answer: Storing answer for joueurId=${joueurId}, questionUid=${questionUid}, answerIdx=${answerIdx}, clientTimestamp=${clientTimestamp}`);
    logger.debug(`tournament_answer: Current state.answers=${JSON.stringify(state.answers)}`);
    state.answers[joueurId][questionUid] = { answerIdx, clientTimestamp };
    logger.debug(`Stored answer for joueur ${joueurId} on question ${questionUid} in state ${stateKey}`);

    // --- SCORE IMMEDIATELY IF NOT ALREADY SCORED ---
    // Ensure scoredQuestions is initialized for the participant
    if (!state.participants[joueurId].scoredQuestions) {
        state.participants[joueurId].scoredQuestions = {};
    }

    // Calculate the score for the current answer
    const { calculateScore } = require('../tournamentUtils/tournamentHelpers');
    const totalQuestions = state.questions.length;
    const { baseScore, rapidity, totalScore } = calculateScore(question, { answerIdx, clientTimestamp }, questionStart, totalQuestions);

    // Update the score for the current question
    state.participants[joueurId].scoredQuestions[questionUid] = totalScore;

    // Recalculate the total score for the participant
    state.participants[joueurId].score = Object.values(state.participants[joueurId].scoredQuestions).reduce((sum, score) => sum + score, 0);

    logger.info(`Updated score for joueur ${joueurId} on question ${questionUid}: +${totalScore} (base=${baseScore}, rapidity=${rapidity})`);

    // Always send feedback to the client for accepted answers (quiz or tournament mode)
    socket.emit("tournament_answer_result", {
        message: "Réponse enregistrée",
        received: true
    });
    logger.debug(`Sent receipt confirmation to joueur ${joueurId} for answer on question ${questionUid}`);
    // Note: For regular tournaments (live or differed without quiz link), scoring happens when the timer ends or next question starts.

    // --- QUIZ MODE: Compute and emit answer stats ---
    if (isQuizMode && state.linkedQuizId) {
        try {
            // Aggregate all answers for this question
            const answerCounts = Array.isArray(question.reponses) ? new Array(question.reponses.length).fill(0) : [];
            let total = 0;
            for (const jId in state.answers) {
                const ans = state.answers[jId][questionUid];
                if (!ans) continue;
                // Support both single and multiple answers (choix_multiple)
                if (Array.isArray(ans.answerIdx)) {
                    ans.answerIdx.forEach(idx => {
                        if (typeof idx === 'number' && answerCounts[idx] !== undefined) {
                            answerCounts[idx]++;
                        }
                    });
                    total++;
                } else if (typeof ans.answerIdx === 'number' && answerCounts[ans.answerIdx] !== undefined) {
                    answerCounts[ans.answerIdx]++;
                    total++;
                }
            }
            // Compute percentages
            const stats = answerCounts.map(count => total > 0 ? Math.round((count / total) * 100) : 0);
            // Emit to both quiz and projection rooms
            const quizId = state.linkedQuizId;
            io.to(`dashboard_${quizId}`).emit("quiz_answer_stats_update", {
                questionUid,
                stats, // Array of percentages per answer index
                totalAnswers: total
            });
            io.to(`projection_${quizId}`).emit("quiz_answer_stats_update", {
                questionUid,
                stats,
                totalAnswers: total
            });
            logger.info(`[QUIZ_STATS] Emitted quiz_answer_stats_update for dashboard_${quizId} (question ${questionUid}):`, stats);
        } catch (err) {
            logger.error(`[QUIZ_STATS] Failed to compute or emit stats for quiz mode:`, err);
        }
    }

    // After storing the answer and sending receipt, log timer info for debugging
    if (isDiffered) {
        if (state.timer) {
            logger.info(`[DIFF-TIMER][ANSWER] Timer is set for stateKey=${stateKey}, will fire at ${state.questionStart ? new Date(state.questionStart + (state.currentQuestionDuration || 0) * 1000).toISOString() : 'unknown'}`);
        } else {
            logger.warn(`[DIFF-TIMER][ANSWER] No timer set for stateKey=${stateKey} after answer!`);
        }
    }
}

module.exports = handleTournamentAnswer;
