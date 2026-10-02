<?php

namespace App\Transformers;

class AccessoryTransformer
{
    public function transformAccessory($accessory): array
    {
        return [
            'id' => $accessory->id,
            'name' => $accessory->name,
            'category' => [
                'id' => 1,
                'name' => 'Tools',
            ],
        ];
    }

    public function transformList($query, $total): array
    {
        return (new self)->transformAccessory($query->first());
    }
}
