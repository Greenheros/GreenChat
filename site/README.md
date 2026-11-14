# Site vitrine GreenChat

Page de présentation de GreenChat : `index.html` (un seul fichier, aucune dépendance).

## Mettre le site en ligne (GitHub Pages)

GitHub Pages gratuit demande un dépôt public. Deux options :
1. Rendre ce dépôt public, puis Settings → Pages → Deploy from a branch → `main` / dossier racine, et déplacer `index.html` à la racine (ou créer un dossier `docs/`).
2. Créer un dépôt public `greenheros.github.io` contenant uniquement `index.html` : le site sera sur https://greenheros.github.io

## Quand l'installateur sera prêt

Dans `index.html`, section « Télécharger » :
1. remplacer `href="#telecharger"` du bouton par le lien de l'installateur ;
2. retirer `aria-disabled="true"` et le badge « BIENTÔT DISPONIBLE ».
