/**
 * Quiz API Route
 * 
 * This API route handles quiz operations:
 * - GET: Retrieves all quizzes with their basic information
 * - POST: Creates a new quiz with specified properties
 * 
 * Quizzes represent collections of questions that can be used for tournaments
 * or classroom activities. They are primarily created and managed by teachers.
 * 
 * The route includes logging for debugging purposes and proper error handling
 * for all operations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import createLogger from '@logger';
import { Logger } from '@/types';

const logger = createLogger('API:Quiz') as Logger;
const prisma = new PrismaClient();


export async function GET(req: NextRequest) {
    logger.debug('GET /api/quiz called');
    try {
        const { searchParams } = new URL(req.url);
        const enseignant_id = searchParams.get('enseignant_id');
        if (!enseignant_id) {
            logger.warn('GET /api/quiz called without enseignant_id');
            return NextResponse.json({ error: 'enseignant_id requis' }, { status: 400 });
        }
        const quizzes = await prisma.quiz.findMany({
            where: { enseignant_id },
            select: {
                id: true,
                nom: true,
                questions_ids: true,
                enseignant_id: true,
                date_creation: true,
                niveaux: true,
                categories: true,
                themes: true,
                type: true,
            },
            orderBy: { date_creation: 'desc' },
        });
        return NextResponse.json(quizzes);
    } catch (e) {
        logger.error('Error in GET /api/quiz:', e);
        return NextResponse.json({ error: 'Erreur lors de la récupération des quiz' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();
        // Validation minimale
        if (!data.nom || !data.enseignant_id || !Array.isArray(data.questions_ids)) {
            logger.warn('Invalid data in POST /api/quiz', {
                hasName: !!data.nom,
                hasTeacherId: !!data.enseignant_id,
                hasQuestions: Array.isArray(data.questions_ids)
            });
            return new Response(JSON.stringify({ error: "Champs obligatoires manquants" }), { status: 400 });
        }
        const prisma = new PrismaClient();
        const quiz = await prisma.quiz.create({
            data: {
                nom: data.nom,
                enseignant_id: data.enseignant_id,
                questions_ids: data.questions_ids,
                type: data.type || "standard",
                niveaux: data.niveaux || [],
                categories: data.categories || [],
                themes: data.themes || [],
            },
        });
        logger.info('Quiz created successfully', { quizId: quiz.id, name: quiz.nom });
        return new Response(JSON.stringify(quiz), { status: 201 });
    } catch (e) {
        logger.error('Error in POST /api/quiz:', e);
        return new Response(JSON.stringify({ error: "Erreur lors de la création du quiz" }), { status: 500 });
    }
}
