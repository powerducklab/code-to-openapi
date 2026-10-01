<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class CreateUserRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'name' => 'required|string|max:255',
            'age' => 'nullable|integer',
            'tags' => 'nullable|array',
            'tags.*' => 'string',
        ];
    }
}
