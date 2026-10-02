<?php

namespace App\Dto;

final class BookDto
{
    public function __construct(
        public readonly string $title,
        public readonly int $year,
        public readonly bool $published = false,
    ) {
    }
}
