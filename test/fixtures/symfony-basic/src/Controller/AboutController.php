<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/about', name: 'about')]
class AboutController extends AbstractController
{
    public function __invoke(): \Symfony\Component\HttpFoundation\Response
    {
        return $this->render('about.html.twig');
    }
}
