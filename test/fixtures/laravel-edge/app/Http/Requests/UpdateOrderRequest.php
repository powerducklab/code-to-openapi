<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateOrderRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'amount' => ['required', 'numeric', 'min:0'],
            'note' => ['string', 'max:200', 'nullable'],
            'tags' => ['array'],
            'tags.*' => ['string'],
        ];
    }
}
