<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreProductRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'sku' => 'required|string|max:64',
            'name' => 'required|string|max:255',
            'price' => 'required|numeric|min:0',
            'active' => 'boolean',
            'tags' => 'array',
            'tags.*' => 'string',
            'category' => 'required|in:electronics,books,home',
        ];
    }
}
