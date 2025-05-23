import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { createLogger } from '@/clientLogger';
import { Socket } from 'socket.io-client';
import type { QuizState } from '@/hooks/useTeacherQuizSocket';

const logger = createLogger('TournamentCodeManager');

interface TournamentCodeManagerProps {
    quizId: string;
    quizSocket: Socket | null;
    quizState: QuizState | null;
    initialTournamentCode: string | null;
    onCodeGenerated: (code: string | null) => void;
    onCodeUpdateEmitted: (code: string) => void;
    onRequestGenerateCode?: () => void;
}

// Define the interface for the imperative handle
export interface TournamentCodeManagerRef {
    generateTournament: () => void;
}

const TournamentCodeManager = forwardRef<TournamentCodeManagerRef, TournamentCodeManagerProps>(({
    quizId,
    quizSocket,
    quizState,
    initialTournamentCode,
    onCodeGenerated,
    onCodeUpdateEmitted,
    onRequestGenerateCode,
}, ref) => {
    const [tournamentCode, setTournamentCode] = useState<string | null>(initialTournamentCode);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setTournamentCode(initialTournamentCode);
    }, [initialTournamentCode]);

    const handleGenerateTournament = async () => {
        setGenerating(true);
        setError(null);
        setTournamentCode(null);

        try {
            const res = await fetch(`/api/quiz/${quizId}/tournament-code`, {
                method: 'POST',
            });
            const data = await res.json();

            if (res.ok && data.tournament_code) {
                const newCode = data.tournament_code;
                setTournamentCode(newCode);
                onCodeGenerated(newCode);

                if (quizSocket) {
                    logger.info('Resetting quiz ended state after new tournament code');
                    quizSocket.emit('quiz_reset_ended', { quizId });
                }

                if (quizSocket) {
                    logger.info(`New tournament code generated: ${newCode}, informing server`);
                    onCodeUpdateEmitted(newCode);
                    if (quizState &&
                        typeof quizState.currentQuestionIdx === 'number' &&
                        quizState.currentQuestionIdx >= 0) {
                        logger.info(`Re-emitting current question with new tournament code`);
                        const currentIdx = quizState.currentQuestionIdx;
                        const chrono = quizState.chrono?.timeLeft;
                        quizSocket.emit("quiz_set_question", {
                            quizId,
                            questionIdx: currentIdx,
                            chrono: chrono,
                            code: newCode
                        });
                    }
                }
            } else {
                const errorMsg = data.message || 'Erreur lors de la génération';
                setError(errorMsg);
                setTournamentCode(null);
                onCodeGenerated(null);
                logger.error(`Error generating tournament code: ${errorMsg}`);
            }
        } catch (err) {
            const errorMsg = 'Erreur réseau ou serveur lors de la génération';
            setError(errorMsg);
            setTournamentCode(null);
            onCodeGenerated(null);
            logger.error(errorMsg, err);
        } finally {
            setGenerating(false);
        }
    };

    useImperativeHandle(ref, () => ({
        generateTournament: handleGenerateTournament
    }));

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-4">
                <h2 className="text-xl font-semibold">Code&nbsp;:</h2>
                {tournamentCode && !error && (
                    <span className="font-mono text-2xl font-bold">{tournamentCode}</span>
                )}
                <button
                    className="btn btn-primary"
                    onClick={onRequestGenerateCode ? onRequestGenerateCode : handleGenerateTournament}
                    disabled={generating || !quizSocket}
                >
                    {generating ? 'Génération...' : (tournamentCode ? 'Nouveau code' : 'Générer un code')}
                </button>
            </div>
            {error && (
                <div className="alert alert-error">
                    <span>{error}</span>
                </div>
            )}
            {!tournamentCode && !generating && !error && (
                <div className="text-gray-500 italic">Aucun code tournoi actif. Cliquez sur &quot;Générer un code&quot;.</div>
            )}
        </div>
    );
});
TournamentCodeManager.displayName = 'TournamentCodeManager';

export default TournamentCodeManager;

