<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreProductRequest;
use App\Http\Resources\ProductCollection;
use App\Http\Resources\ProductResource;
use App\Models\Product;

class ProductController extends Controller
{
    public function index(): ProductCollection
    {
        return new ProductCollection(Product::paginate());
    }

    public function show(string $id): ProductResource
    {
        return new ProductResource(Product::findOrFail($id));
    }

    public function store(StoreProductRequest $request): ProductResource
    {
        $product = Product::create($request->validated());
        return new ProductResource($product);
    }
}
