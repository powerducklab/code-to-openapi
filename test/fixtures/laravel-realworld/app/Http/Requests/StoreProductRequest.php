<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreProductRequest extends FormRequest
{
    public function rules()
    {
        return [
            'name' => 'required|string|max:120',
            'price' => 'required|numeric|min:0',
            'tags' => 'array',
            'tags.*' => 'string',
            'category_id' => 'integer|nullable',
        ];
    }
}
