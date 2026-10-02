<?php

namespace App\Http\Controllers\Api;

use App\Helpers\ApiHelper;
use App\Http\Controllers\Controller;
use App\Transformers\AccessoryTransformer;
use Illuminate\Http\JsonResponse;

class AccessoryController extends Controller
{
    public function show($id): array
    {
        $accessory = ['id' => $id];
        return (new AccessoryTransformer)->transformAccessory($accessory);
    }

    public function list($filter): array
    {
        return (new AccessoryTransformer)->transformList($filter, 10);
    }

    public function store(): JsonResponse
    {
        return response()->json(ApiHelper::formatStandardApiResponse('success', ['id' => 1], 'created'));
    }
}
