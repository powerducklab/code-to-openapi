<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class CatalogController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(['items' => []]);
    }

    public function show(string $id): JsonResponse
    {
        return response()->json(['id' => $id]);
    }
}
