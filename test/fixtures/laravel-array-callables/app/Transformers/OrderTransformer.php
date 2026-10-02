<?php

namespace App\Transformers;

class OrderTransformer
{
    public function transformOrder($order): array
    {
        return [
            'id' => $order->id,
            'reference' => $order->reference,
        ];
    }
}
