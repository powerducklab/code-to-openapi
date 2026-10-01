<?php

namespace App\Models;

class Product
{
    public string $id;
    public string $name;
    public float $price;
    /** @var string[] */
    public array $tags;
    public ?Category $category;
}
