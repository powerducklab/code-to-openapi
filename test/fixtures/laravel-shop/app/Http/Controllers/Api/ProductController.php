<?php

namespace App\Http\Controllers\Api;

use App\Http\Requests\StoreProductRequest;
use App\Http\Requests\UpdateProductRequest;
use App\Http\Resources\ProductCollection;
use App\Http\Resources\ProductResource;
use App\Models\Product;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ProductController extends Controller
{
    public function index(Request $request): ProductCollection
    {
        $query = Product::query();
        if ($request->boolean('active')) {
            $query->where('active', true);
        }
        $keyword = $request->query('keyword');
        if ($keyword) {
            $query->where('name', 'like', "%{$keyword}%");
        }
        $perPage = (int) $request->query('per_page', '20');
        return new ProductCollection($query->paginate($perPage));
    }

    public function store(StoreProductRequest $request): JsonResponse
    {
        $product = Product::create($request->validated());
        return (new ProductResource($product))->response()->setStatusCode(201);
    }

    public function show(Product $product): ProductResource
    {
        return new ProductResource($product);
    }

    public function update(UpdateProductRequest $request, Product $product): ProductResource
    {
        $product->update($request->validated());
        return new ProductResource($product);
    }

    public function destroy(Product $product): JsonResponse
    {
        $product->delete();
        return response()->json(null, 204);
    }

    public function uploadImage(Request $request, Product $product): JsonResponse
    {
        $request->validate([
            'image' => 'required|file|mimes:jpg,png|max:2048',
            'caption' => 'nullable|string|max:255',
        ]);
        $path = $request->file('image')->store('products');
        return response()->json(['path' => $path, 'caption' => $request->input('caption')], 201);
    }

    public function events(Product $product): StreamedResponse
    {
        return response()->stream(function () {
            echo "event: update\ndata: {}\n\n";
            ob_flush();
            flush();
        }, 200, ['Content-Type' => 'text/event-stream']);
    }
}
