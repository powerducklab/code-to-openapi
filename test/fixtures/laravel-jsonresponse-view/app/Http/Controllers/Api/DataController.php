<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

class DataController extends Controller
{
    public function show(): JsonResponse
    {
        return new JsonResponse([
            'message' => 'ok',
            'count' => 3,
        ]);
    }

    public function error(): JsonResponse
    {
        return new JsonResponse(['message' => 'nope'], 400);
    }

    public function assigned(): JsonResponse
    {
        $response = new JsonResponse(['status' => 'done']);
        return $response;
    }
}
