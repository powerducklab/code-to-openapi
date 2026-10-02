<?php

namespace App\Controller;

use App\Dto\BookDto;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Request\Attribute\MapQueryParameter;
use Symfony\Component\Request\Attribute\MapRequestPayload;

#[Route('/api/books', name: 'books_')]
class BookController extends AbstractController
{
    #[Route('', name: 'list', methods: ['GET'])]
    public function list(#[MapQueryParameter] int $page = 1, #[MapQueryParameter] string $q = ''): JsonResponse
    {
        return $this->json([
            'items' => [['id' => 1, 'title' => 'Symfony Guide']],
            'page' => $page,
            'q' => $q,
        ]);
    }

    #[Route('/{id}', name: 'show', methods: ['GET'])]
    public function show(int $id): JsonResponse
    {
        return new JsonResponse(['id' => $id, 'title' => 'A Book']);
    }

    #[Route('', name: 'create', methods: ['POST'])]
    public function create(#[MapRequestPayload] BookDto $dto): JsonResponse
    {
        return $this->json(['id' => 42, 'title' => $dto->title], 201);
    }

    #[Route('/{id}/html', name: 'render', methods: ['GET'])]
    public function renderHtml(int $id): Response
    {
        return $this->render('book/show.html.twig', ['id' => $id]);
    }

    #[Route('/{id}/file', name: 'download', methods: ['GET'])]
    public function download(int $id): StreamedResponse
    {
        return new StreamedResponse(function () {
            echo 'binary';
        }, 200, ['Content-Type' => 'application/octet-stream']);
    }

    #[Route('/{id}/go', name: 'redirect', methods: ['GET'])]
    public function go(int $id): Response
    {
        return $this->redirectToRoute('books_show', ['id' => $id], 301);
    }
}
