<?php

namespace App\Models;

class User
{
    public function __construct(
        public string $id,
        public string $name,
        public ?int $age = null,
        public array $tags = [],
    ) {}
}
