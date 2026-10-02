<?php

namespace App\Http\Controllers\Catalog;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

class ProductController extends Controller
{
    public function index(): JsonResponse
    {
        return new JsonResponse(['items' => []]);
    }

    public function show($id): JsonResponse
    {
        return new JsonResponse(['id' => $id]);
    }
}
